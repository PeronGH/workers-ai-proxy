const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
	'Access-Control-Allow-Headers': '*',
	'Access-Control-Max-Age': '86400',
} as const;

function withCors(res: Response): Response {
	const headers = new Headers(res.headers);
	for (const [k, v] of Object.entries(CORS_HEADERS)) {
		headers.set(k, v);
	}
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function text(body: string, status: number): Response {
	return new Response(body, { status, headers: CORS_HEADERS });
}

export default {
	async fetch(request, env): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		const { pathname } = new URL(request.url);

		const affinity = request.headers.get('Authorization') ?? request.headers.get('CF-Connecting-IP') ?? '';
		const runOpts = {
			returnRawResponse: true,
			headers: { 'x-session-affinity': affinity },
		} as const;

		// Run a model by id, forwarding the request body verbatim: POST /run/@cf/<model>
		if (pathname.startsWith('/run/')) {
			if (request.method !== 'POST') {
				return text('method not allowed\n', 405);
			}
			const model = pathname.slice('/run/'.length) as keyof AiModels;
			const inputs = await request.json<Record<string, unknown>>();
			const res = await env.AI.run(model, inputs, runOpts);
			return withCors(res);
		}

		// OpenAI-style endpoint: POST /v1/... with `model` in the JSON body.
		if (pathname.startsWith('/v1/')) {
			if (request.method !== 'POST') {
				return text('method not allowed\n', 405);
			}
			const { model, ...payload } = await request.json<{ model: string } & Record<string, unknown>>();
			const modelId = (model.startsWith('@') ? model : `@cf/${model}`) as keyof AiModels;
			const inputs: Record<string, unknown> = { chat_template_kwargs: { thinking: true, preserve_thinking: true }, ...payload };
			const res = await env.AI.run(modelId, inputs, runOpts);
			return withCors(res);
		}

		return text('not found\n', 404);
	},
} satisfies ExportedHandler<Env>;
