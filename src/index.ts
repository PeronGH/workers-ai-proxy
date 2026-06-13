import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';

const app = new Hono<{ Bindings: Env }>();

app.use(
	'*',
	cors({
		origin: '*',
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
		allowHeaders: ['*'],
		maxAge: 86400,
	}),
);

// Route same-session requests to the same model instance for prefix-cache hits.
// https://developers.cloudflare.com/workers-ai/features/prompt-caching/
function runOptions(c: Context) {
	const affinity = c.req.header('Authorization') ?? c.req.header('CF-Connecting-IP') ?? '';
	return { returnRawResponse: true, extraHeaders: { 'x-session-affinity': affinity } } as const;
}

// Run a model by id, forwarding the request body verbatim: POST /run/@cf/<model>
app.post('/run/:model{.+}', async (c) => {
	const model = c.req.param('model') as keyof AiModels;
	const inputs = await c.req.json<Record<string, unknown>>();
	return c.env.AI.run(model, inputs, runOptions(c));
});

// OpenAI-compatible chat completions: POST /v1/chat/completions with `model` in the body.
app.post('/v1/chat/completions', async (c) => {
	const { model, ...payload } = await c.req.json<{ model: string } & Record<string, unknown>>();
	const modelId = (model.startsWith('@') ? model : `@cf/${model}`) as keyof AiModels;
	const inputs: Record<string, unknown> = { chat_template_kwargs: { thinking: true, preserve_thinking: true }, ...payload };
	return c.env.AI.run(modelId, inputs, runOptions(c));
});

export default app;
