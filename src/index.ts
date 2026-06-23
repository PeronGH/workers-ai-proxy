import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { antReqToOaiReq, oaiResToAntRes, oaiStreamToAntStream } from '@peron_js/oai2ant';
import type { OpenAIResponse, OpenAIStreamChunk } from '@peron_js/oai2ant';
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';
import { parseSseData, sseFromItems } from './stream';

type Variables = { apiKey: string };

// Different model chat templates read different thinking flags, so extend Workers AI's typed
// kwargs (enable_thinking/clear_thinking) with the thinking/preserve_thinking knobs and set both.
type CustomInputs = Omit<ChatCompletionsInput, 'chat_template_kwargs'> & {
	chat_template_kwargs: ChatTemplateKwargs & { thinking: boolean; preserve_thinking: boolean };
};

// OpenAI clients may send reasoning_effort: "none"; the Workers type only allows low/medium/high.
type ChatBody = Omit<ChatCompletionsMessagesInput, 'reasoning_effort'> & {
	reasoning_effort?: ChatCompletionsMessagesInput['reasoning_effort'] | 'none';
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use(
	'*',
	cors({
		origin: '*',
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
		allowHeaders: ['*'],
		maxAge: 86400,
	}),
);

// Hash an API key into a stable, opaque token. Workers exposes MD5 through Web Crypto.
async function md5Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Require an API key on every proxied request, stashing it for downstream session affinity.
// Accept OpenAI-style `Authorization: Bearer` and Anthropic-style `x-api-key`.
const requireApiKey = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
	const key = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ?? c.req.header('x-api-key');
	if (!key) {
		return c.text('API key is required\n', 401);
	}
	c.set('apiKey', key);
	return next();
});

// Route same-session requests to the same model instance for prefix-cache hits, keyed by a hash of
// the API key so the raw key never leaves in upstream headers.
// https://developers.cloudflare.com/workers-ai/features/prompt-caching/
async function runOptions(c: Context<{ Bindings: Env; Variables: Variables }>) {
	return { returnRawResponse: true, extraHeaders: { 'x-session-affinity': await md5Hex(c.get('apiKey')) } } as const;
}

app.use('/run/*', requireApiKey);
app.use('/v1/*', requireApiKey);

// Run a model by id, forwarding the request body verbatim: POST /run/@cf/<model>
app.post('/run/:model{.+}', async (c) => {
	const model = c.req.param('model') as keyof AiModels;
	const inputs = await c.req.json<Record<string, unknown>>();
	return c.env.AI.run(model, inputs, await runOptions(c));
});

// Build the Workers AI request body from an OpenAI-compatible chat request, applying our defaults.
function buildInputs(body: ChatBody): { modelId: keyof AiModels; inputs: CustomInputs } {
	const { model, messages, reasoning_effort, ...payload } = body;
	if (!model) throw new HTTPException(400, { message: 'model is required\n' });

	const modelId = (model.startsWith('@') ? model : `@cf/${model}`) as keyof AiModels;

	// Thinking is on by default; only an explicit reasoning_effort of "none" disables it.
	const thinking = reasoning_effort !== 'none';
	const inputs: CustomInputs = {
		...payload,
		temperature: payload.temperature ?? (thinking ? 1 : 0.7),
		top_p: payload.top_p ?? 0.95,
		// Models on Workers AI generally don't support the OpenAI "developer" role.
		messages: messages.map((m) => (m.role === 'developer' ? { ...m, role: 'system' } : m)),
		// preserve_thinking/clear_thinking are inverse: preserving reasoning context means not clearing it.
		chat_template_kwargs: { thinking, enable_thinking: thinking, preserve_thinking: true, clear_thinking: false },
	};

	return { modelId, inputs };
}

// Drop the choice-less usage trailer Workers AI tacks onto its OpenAI stream — it breaks strict
// OpenAI clients and crashes the Anthropic converter (which dereferences `choices[0]`).
async function* withChoices(chunks: AsyncIterable<OpenAIStreamChunk>): AsyncGenerator<OpenAIStreamChunk> {
	for await (const chunk of chunks) {
		if (Array.isArray(chunk.choices)) yield chunk;
	}
}

// OpenAI-compatible chat completions: POST /v1/chat/completions with `model` in the body. Workers AI
// already speaks OpenAI, so non-streaming responses pass straight through; a stream is decoded once,
// the trailer dropped, and re-emitted as OpenAI SSE.
app.post('/v1/chat/completions', async (c) => {
	const body = await c.req.json<ChatBody>();
	const { modelId, inputs } = buildInputs(body);
	const res = await c.env.AI.run(modelId, inputs as Record<string, unknown>, await runOptions(c));
	if (!body.stream || !res.ok || !res.body) return res;

	const chunks = withChoices(parseSseData<OpenAIStreamChunk>(res.body as ReadableStream<Uint8Array>));
	const out = sseFromItems(chunks, (chunk) => `data: ${JSON.stringify(chunk)}\n\n`, 'data: [DONE]\n\n');
	return new Response(out, { headers: { 'content-type': 'text/event-stream' } });
});

// Anthropic-compatible messages: POST /v1/messages. Convert the request to OpenAI form, run it, then
// convert the OpenAI response to Anthropic form — a single one-way translation in each direction.
app.post('/v1/messages', async (c) => {
	const antReq = await c.req.json<MessageCreateParams>();
	const oaiReq = antReqToOaiReq(antReq);
	// oai2ant emits the OpenAI SDK's request shape, structurally the same OpenAI-compatible body
	// Workers AI accepts; the only divergence is nullable message content, harmless here.
	const { modelId, inputs } = buildInputs(oaiReq as unknown as ChatBody);
	const res = await c.env.AI.run(modelId, inputs as Record<string, unknown>, await runOptions(c));
	if (!res.ok || !res.body) return res; // pass upstream errors through unchanged

	if (oaiReq.stream) {
		const events = oaiStreamToAntStream(withChoices(parseSseData<OpenAIStreamChunk>(res.body as ReadableStream<Uint8Array>)));
		const out = sseFromItems(events, (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		return new Response(out, { headers: { 'content-type': 'text/event-stream' } });
	}

	const oaiRes = await res.json<OpenAIResponse>();
	return c.json(oaiResToAntRes(oaiRes));
});

export default app;
