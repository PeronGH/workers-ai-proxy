import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { transformLines } from './stream';

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

// Drop SSE `data:` chunks whose JSON payload lacks a `choices` array (e.g. the usage-only
// trailer). Everything else — the [DONE] sentinel, blank separators, non-JSON lines — is kept.
function filterChunk(line: string): string | null {
	if (!line.startsWith('data:')) {
		return line;
	}
	const payload = line.slice('data:'.length);
	let data: unknown;
	try {
		data = JSON.parse(payload);
	} catch {
		return line;
	}
	const hasChoices = typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>)['choices']);
	return hasChoices ? line : null;
}

// Hash an API key into a stable, opaque token. Workers exposes MD5 through Web Crypto.
async function md5Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Require an API key on every proxied request, stashing it for downstream session affinity.
const requireApiKey = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
	const auth = c.req.header('Authorization');
	if (!auth) {
		return c.text('API key is required\n', 401);
	}
	c.set('apiKey', auth.replace(/^Bearer\s+/i, ''));
	return next();
});

// Log each proxied request once the response is ready, identified by the calling API key.
const logRequests = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
	await next();
	console.log(JSON.stringify({ apiKey: c.get('apiKey'), method: c.req.method, path: c.req.path, status: c.res.status }));
});

// Route same-session requests to the same model instance for prefix-cache hits, keyed by a hash of
// the API key so the raw key never leaves in upstream headers.
// https://developers.cloudflare.com/workers-ai/features/prompt-caching/
async function runOptions(c: Context<{ Bindings: Env; Variables: Variables }>) {
	return { returnRawResponse: true, extraHeaders: { 'x-session-affinity': await md5Hex(c.get('apiKey')) } } as const;
}

app.use('/run/*', requireApiKey, logRequests);
app.use('/v1/*', requireApiKey, logRequests);

// Run a model by id, forwarding the request body verbatim: POST /run/@cf/<model>
app.post('/run/:model{.+}', async (c) => {
	const model = c.req.param('model') as keyof AiModels;
	const inputs = await c.req.json<Record<string, unknown>>();
	return c.env.AI.run(model, inputs, await runOptions(c));
});

// OpenAI-compatible chat completions: POST /v1/chat/completions with `model` in the body.
app.post('/v1/chat/completions', async (c) => {
	const { model, messages, reasoning_effort, ...payload } = await c.req.json<ChatBody>();
	if (!model) {
		return c.text('model is required\n', 400);
	}

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

	// The typed `run` overloads can't model an arbitrary forwarded body; widen to hit the raw-response overload.
	const res = await c.env.AI.run(modelId, inputs as Record<string, unknown>, await runOptions(c));

	if (!payload.stream || !res.body) return res;

	// Re-emit the SSE stream one line at a time, dropping choice-less chunks.
	const body = transformLines(res.body as ReadableStream<Uint8Array>, filterChunk);
	return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
});

export default app;
