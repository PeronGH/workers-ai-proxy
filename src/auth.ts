import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { importJWK, jwtVerify } from 'jose';

export type User = { id: string; models: RegExp };
export type AuthEnv = { Bindings: Env; Variables: { user: User } };

// Every proxied request carries an EdDSA JWT as OpenAI-style `Authorization: Bearer` or
// Anthropic-style `x-api-key`. Its `sub` is the user id and `models` a regex over model ids;
// both are trusted once the signature checks out against JWT_PUBLIC_KEY.
export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
	const token = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ?? c.req.header('x-api-key');
	if (!token) throw new HTTPException(401, { message: 'API key is required' });

	const key = await importJWK(c.env.JWT_PUBLIC_KEY, 'EdDSA');
	const { payload } = await jwtVerify(token, key, { algorithms: ['EdDSA'] }).catch((err: Error) => {
		throw new HTTPException(401, { message: `Invalid token: ${err.message}` });
	});
	const { sub, models } = payload;
	if (typeof sub !== 'string' || typeof models !== 'string') {
		throw new HTTPException(401, { message: 'Token must carry sub and models' });
	}

	// Anchor so a pattern like `@cf/moonshotai/.*` cannot match by substring.
	c.set('user', { id: sub, models: new RegExp(`^(?:${models})$`) });
	return next();
});
