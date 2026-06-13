# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

This project uses **bun**. Use `bun`/`bunx`, not `npm`/`npx`.

| Command              | Purpose                                      |
| -------------------- | -------------------------------------------- |
| `bun run dev`        | Local development (`wrangler dev`)           |
| `bun run deploy`     | Deploy to Cloudflare                         |
| `bun run cf-typegen` | Generate TypeScript types (`wrangler types`) |
| `bun run typecheck`  | Type-check with `tsc --noEmit`               |
| `bun run lint`       | ESLint + Prettier check                      |
| `bun run format`     | Format with Prettier                         |

Run `bun run cf-typegen` after changing bindings in wrangler.jsonc.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
