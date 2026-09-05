# workers-ai-proxy

A Cloudflare Worker that exposes [Workers AI](https://developers.cloudflare.com/workers-ai/) behind OpenAI- and Anthropic-compatible endpoints, so any OpenAI or Anthropic SDK can call Workers AI models by pointing its base URL at the Worker.

Every run goes through an [AI Gateway](https://developers.cloudflare.com/ai-gateway/) named `proxy` with retries on, caching off, and request metadata logged without prompts or completions. Requests are pinned to a model instance via `x-session-affinity` for prefix-cache hits, keyed on the client's `x-session-affinity` header, then `prompt_cache_key`, then the API key and client IP.

## Endpoints

All endpoints require an API key in `Authorization: Bearer <key>` or `x-api-key`. The key is not verified; it only has to be present and is used to derive session affinity.

| Route                       | Behavior                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST /v1/chat/completions` | OpenAI chat completions. `model` is the Workers AI model id. Streaming and non-streaming pass through.    |
| `POST /v1/messages`         | Anthropic messages. Translated to and from OpenAI form via `@peron_js/oai2ant`.                           |
| `POST /run/<model>`         | Raw Workers AI run. The body is forwarded verbatim; `prompt_cache_key` is stripped and used for affinity. |

Chat defaults: thinking is enabled unless `reasoning_effort` is `"none"`, `temperature` is 1 with thinking and 0.6 without, `top_p` is 0.95, and `developer` messages become `system`. Errors are JSON bodies; upstream errors, including 429s, pass through unchanged.

## Usage

```sh
bun install
bun run dev      # local dev server
bun run deploy   # deploy to Cloudflare
```

Create an AI Gateway named `proxy` in your Cloudflare account before deploying.

## Example

```sh
curl https://<worker>/v1/chat/completions \
  -H 'Authorization: Bearer any-key' \
  -H 'Content-Type: application/json' \
  -d '{"model":"@cf/moonshotai/kimi-k2.5","messages":[{"role":"user","content":"Hi"}]}'
```
