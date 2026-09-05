import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { antReqToOaiReq, oaiResToAntRes, oaiStreamToAntStream } from '@peron_js/oai2ant';
import type { OpenAIResponse, OpenAIStreamChunk } from '@peron_js/oai2ant';
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';
import { parseSseData, sseFromItems } from './stream';
import { requireAuth, type AuthEnv } from './auth';

// OpenAI clients may send reasoning_effort: "none"; the Workers type only allows low/medium/high.
type ChatBody = Omit<ChatCompletionsMessagesInput, 'reasoning_effort'> & {
	reasoning_effort?: ChatCompletionsMessagesInput['reasoning_effort'] | 'none';
	prompt_cache_key?: string;
};

// Different model chat templates read different thinking flags, so extend Workers AI's typed
// kwargs (enable_thinking/clear_thinking) with the thinking/preserve_thinking/drop_thinking knobs
// and set them all. Built on ChatBody so a passed-through reasoning_effort of "none" stays in the type.
type CustomInputs = Omit<ChatBody, 'chat_template_kwargs'> & {
	chat_template_kwargs: ChatTemplateKwargs & {
		thinking: boolean;
		preserve_thinking: boolean;
		drop_thinking: boolean;
		reasoning_effort?: ChatBody['reasoning_effort'];
	};
};

type RunInputs = Record<string, unknown> & { prompt_cache_key?: string };

// Every run goes through this AI Gateway, which owns retries. Retry as hard as the gateway permits
// — 5 attempts is its ceiling and 100ms its delay floor — and serve no cached responses.
// https://developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/
const GATEWAY: GatewayOptions = {
	id: 'proxy',
	retries: { maxAttempts: 5, retryDelayMs: 100, backoff: 'constant' },
	skipCache: true,
	collectLog: true,
};

const app = new Hono<AuthEnv>();

app.use(
	'*',
	cors({
		origin: '*',
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
		allowHeaders: ['*'],
		maxAge: 86400,
	}),
);

// Every proxy-generated error is a JSON body. Clients are trusted, so unhandled errors carry
// their message and stack instead of an opaque "Internal Server Error".
app.onError((err, c) => {
	if (err instanceof HTTPException) return c.json({ error: { message: err.message } }, err.status);
	return c.json({ error: { message: err.message, stack: err.stack } }, 500);
});

// Hash cache affinity inputs into a stable, opaque token. Workers exposes MD5 through Web Crypto.
async function md5Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Authorize the model against the caller's token, then run it through the gateway with the raw
// response returned; upstream failures, including 429, pass straight back to the client. The request's abort signal is threaded in so a client disconnect
// cancels the in-flight run. Session affinity routes same-session requests to the same model instance
// for prefix-cache hits. https://developers.cloudflare.com/workers-ai/features/prompt-caching/
async function run(c: Context<AuthEnv>, model: keyof AiModels, inputs: RunInputs): Promise<Response> {
	const user = c.get('user');
	if (!user.models.test(model)) throw new HTTPException(403, { message: `Model ${model} is not allowed` });

	const { prompt_cache_key, ...runInputs } = inputs;
	const ip = c.req.header('CF-Connecting-IP') ?? '';
	const ua = c.req.header('User-Agent') ?? '';
	const affinityInput = c.req.header('x-session-affinity') ?? prompt_cache_key ?? JSON.stringify([user.id, ip]);
	const session = await md5Hex(affinityInput);
	return c.env.AI.run(model, runInputs, {
		returnRawResponse: true,
		gateway: { ...GATEWAY, metadata: { ip, userId: user.id } },
		extraHeaders: {
			'x-session-affinity': session,
			'User-Agent': ua,
			// Log that metadata but never the prompt or the completion. Only a per-request
			// header draws that line; the gateway has no setting for it.
			'cf-aig-collect-log-payload': 'false',
		},
		signal: c.req.raw.signal,
	});
}

app.use('/run/*', requireAuth);
app.use('/v1/*', requireAuth);

// Run a model by id, forwarding the request body verbatim: POST /run/@cf/<model>
app.post('/run/:model{.+}', async (c) => {
	const model = c.req.param('model') as keyof AiModels;
	const inputs = await c.req.json<Record<string, unknown>>();
	return run(c, model, inputs);
});

// Build the Workers AI request body from an OpenAI-compatible chat request, applying our defaults.
function buildInputs(body: ChatBody): { modelId: keyof AiModels; inputs: CustomInputs } {
	const { model, messages, ...payload } = body;
	if (!model) throw new HTTPException(400, { message: 'model is required' });

	const modelId = model as keyof AiModels;

	// Thinking is on by default; only an explicit reasoning_effort of "none" disables it.
	const thinking = payload.reasoning_effort !== 'none';
	const inputs: CustomInputs = {
		...payload,
		temperature: payload.temperature ?? (thinking ? 1 : 0.6),
		top_p: payload.top_p ?? 0.95,
		// Models on Workers AI generally don't support the OpenAI "developer" role.
		messages: messages.map((m) => (m.role === 'developer' ? { ...m, role: 'system' } : m)),
		// preserve_thinking is the inverse of clear_thinking/drop_thinking: preserving reasoning
		// context means not clearing or dropping it.
		chat_template_kwargs: {
			thinking,
			enable_thinking: thinking,
			preserve_thinking: true,
			clear_thinking: false,
			drop_thinking: false,
			reasoning_effort: payload.reasoning_effort,
		},
	};

	return { modelId, inputs };
}

// OpenAI-compatible chat completions: POST /v1/chat/completions with `model` in the body. Workers AI
// already speaks OpenAI, so the response — streaming or not — passes straight through.
app.post('/v1/chat/completions', async (c) => {
	const body = await c.req.json<ChatBody>();
	const { modelId, inputs } = buildInputs(body);
	return run(c, modelId, inputs);
});

// Anthropic-compatible messages: POST /v1/messages. Convert the request to OpenAI form, run it, then
// convert the OpenAI response to Anthropic form — a single one-way translation in each direction.
app.post('/v1/messages', async (c) => {
	const antReq = await c.req.json<MessageCreateParams>();
	const oaiReq = antReqToOaiReq(antReq);
	// oai2ant emits the OpenAI SDK's request shape, structurally the same OpenAI-compatible body
	// Workers AI accepts; the only divergence is nullable message content, harmless here.
	const { modelId, inputs } = buildInputs(oaiReq as unknown as ChatBody);
	const res = await run(c, modelId, inputs);
	if (!res.ok || !res.body) return res; // pass upstream errors through unchanged

	if (oaiReq.stream) {
		const events = oaiStreamToAntStream(parseSseData<OpenAIStreamChunk>(res.body as ReadableStream<Uint8Array>));
		const out = sseFromItems(events, (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		return new Response(out, { headers: { 'content-type': 'text/event-stream' } });
	}

	const oaiRes = await res.json<OpenAIResponse>();
	return c.json(oaiResToAntRes(oaiRes));
});

export default app;
