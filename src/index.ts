import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';

// Workers AI's typed chat_template_kwargs (enable_thinking/clear_thinking) doesn't cover the
// thinking/preserve_thinking knobs these models expect, so override it with our own shape.
type CustomInputs = Omit<ChatCompletionsInput, 'chat_template_kwargs'> & {
	chat_template_kwargs: { thinking: boolean; preserve_thinking: boolean };
};

// OpenAI clients may send reasoning_effort: "none"; the Workers type only allows low/medium/high.
type ChatBody = Omit<ChatCompletionsMessagesInput, 'reasoning_effort'> & {
	reasoning_effort?: ChatCompletionsMessagesInput['reasoning_effort'] | 'none';
};

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
	const { model, messages, reasoning_effort, ...payload } = await c.req.json<ChatBody>();
	if (!model) {
		return c.text('model is required\n', 400);
	}

	const modelId = (model.startsWith('@') ? model : `@cf/${model}`) as keyof AiModels;

	const inputs: CustomInputs = {
		...payload,
		// Models on Workers AI generally don't support the OpenAI "developer" role.
		messages: messages.map((m) => (m.role === 'developer' ? { ...m, role: 'system' } : m)),
		chat_template_kwargs: { thinking: false, preserve_thinking: true },
	};

	if (reasoning_effort) {
		inputs.chat_template_kwargs.thinking = reasoning_effort !== 'none';
	}

	// The typed `run` overloads can't model an arbitrary forwarded body; widen to hit the raw-response overload.
	return c.env.AI.run(modelId, inputs as Record<string, unknown>, runOptions(c));
});

export default app;
