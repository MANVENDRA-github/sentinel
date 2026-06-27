# Sentinel

A self-hostable **verifying LLM gateway** — a drop-in, OpenAI-compatible proxy that **routes** (cheapest capable model + fallback), **semantically caches**, and **verifies** (deterministic guardrails inline + a local Ollama judge) every LLM call, with full OpenTelemetry tracing. Unlike after-the-fact observability tools, it can flag or block a bad response _before it returns_.

> 🚧 **Early development.** Product spec in [`PRP_SPEC.md`](./PRP_SPEC.md), phased build in [`ROADMAP.md`](./ROADMAP.md), contributor/agent guidance in [`CLAUDE.md`](./CLAUDE.md). Currently at **Phase 4 — routing, fallback & rate-limit survival** (inline verification lands in later phases).

## What works today (Phase 1)

A drop-in, OpenAI-compatible `POST /v1/chat/completions` endpoint (streaming and non-streaming) that authenticates callers, validates requests, and forwards them to **any OpenAI-compatible provider** you configure — OpenAI, Groq, Mistral, OpenRouter, DeepSeek, xAI, Google Gemini (via its OpenAI endpoint), or a local **Ollama** model. Point your existing OpenAI SDK at Sentinel by changing one line: the base URL.

## Requirements

- **Node ≥ 22** and **pnpm**
- At least one provider: an API key for a hosted provider, and/or a local [**Ollama**](https://ollama.com) install (no key needed)

## Quick start

```bash
pnpm install

# 1. configure providers + secrets (both files are git-ignored)
cp sentinel.config.example.json sentinel.config.json
cp .env.example .env            # add your keys; set SENTINEL_API_KEYS

# 2. (optional) run a local model — no API key required
ollama pull llama3.2            # or any model; make sure `ollama serve` is up

# 3. run the gateway
pnpm dev                        # http://localhost:8080
```

Call it with any OpenAI client — only the base URL changes:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "authorization: Bearer dev-local-key" \
  -H "content-type: application/json" \
  -d '{"model":"llama3.2","messages":[{"role":"user","content":"Say hi in three words"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="dev-local-key")
client.chat.completions.create(
    model="llama3.2",
    messages=[{"role": "user", "content": "hi"}],
)
```

## Configuration

Two git-ignored files:

- **`.env`** — secrets only: provider API keys, and the `SENTINEL_API_KEYS` clients use to authenticate to Sentinel. See [`.env.example`](./.env.example).
- **`sentinel.config.json`** — which providers exist and which model routes where. See [`sentinel.config.example.json`](./sentinel.config.example.json).

Each provider sets a `baseUrl` (or `baseUrlEnv` to read it from the environment) and an optional `apiKeyEnv` naming the env var that holds its key. The `models` map routes a model name to a provider; `defaultProvider` handles anything not listed.

```json
{
  "providers": {
    "ollama": { "type": "openai-compatible", "baseUrlEnv": "OLLAMA_BASE_URL" },
    "openai": {
      "type": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    "groq": {
      "type": "openai-compatible",
      "baseUrl": "https://api.groq.com/openai/v1",
      "apiKeyEnv": "GROQ_API_KEY"
    }
  },
  "models": { "llama3.2": "ollama", "gpt-4o-mini": "openai", "llama-3.3-70b-versatile": "groq" },
  "defaultProvider": "ollama",
  "routing": {
    "tiers": ["llama3.2", "gpt-4o-mini", "llama-3.3-70b-versatile"],
    "fallback": ["llama3.2"]
  }
}
```

A provider may also set an `rpm` (requests-per-minute) ceiling; the optional `routing` block configures cost-aware routing (see below). Because almost every provider speaks the OpenAI API, **bringing your own key is just config** — add a provider entry and a model route, drop the key in `.env`, done.

### Bring your own Ollama

Sentinel never hardcodes a machine or a model. Set `OLLAMA_BASE_URL` in `.env` to point at _your_ Ollama (default `http://localhost:11434/v1`), list the models you've pulled in the `models` map, and you're set. The local **judge** that verifies outputs in a later phase works the same way — it reads `JUDGE_MODEL` from your environment, so every clone uses its own local model, with no API key and no quota.

## Observability

Every request is traced with OpenTelemetry — provider, model, status, latency, and token usage — and persisted to a queryable store (SQLite by default; set `TRACE_DB=memory` for an ephemeral one). Spans also export to any OTLP collector (Jaeger, etc.) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

Read recent traces through the admin-gated API (set `SENTINEL_ADMIN_KEY` to enable it):

```bash
curl http://localhost:8080/traces \
  -H "authorization: Bearer $SENTINEL_ADMIN_KEY"
# filters: ?model=gpt-4o-mini&status=200&stream=true&since=<epoch-ms>&limit=50
```

Traces are **metadata only** — no prompt or response bodies are stored, and API keys are recorded as a SHA-256 hash, never in the clear.

## Caching

Sentinel **semantically caches** responses: it embeds each prompt locally (Ollama `nomic-embed-text`) and, when a new request is similar enough to a recent one (cosine ≥ `CACHE_SIMILARITY_THRESHOLD`, default `0.92`), serves the stored answer **without calling the provider** — replaying buffered SSE chunks for streamed requests. The cache is **per-tenant** (scoped to the calling API key), bounded (`CACHE_MAX_ENTRIES`, `CACHE_TTL_SECONDS`), and **fails open** — any embedding error simply falls through to the provider. Cache hits are visible in traces (`GET /traces?cacheHit=true`). Disable with `CACHE_ENABLED=false`.

## Routing & resilience

Sentinel survives flaky providers and free-tier rate limits instead of passing their failures back to your app. Each request becomes an ordered **candidate chain** that a resilience executor runs in order:

- **Retry + backoff + fallback.** A retryable failure (429, upstream 5xx, timeout, network fault) is retried with exponential backoff up to `MAX_RETRIES`, then **failed over** to the next candidate — additional models you list under `routing.fallback`, ending at a local Ollama model so a request can always be served. Terminal errors (400/401/403/404) fail fast without pointless fallback.
- **Per-provider throttling.** A token-bucket limiter paces each provider to its configured `rpm` (or `DEFAULT_RPM`), waiting up to `THROTTLE_MAX_WAIT_MS` for headroom before skipping to a less-loaded candidate. This keeps you under a provider's limit rather than discovering it the hard way.
- **Cost-aware routing (opt-in).** Send `"model": "auto"` and a rules-based classifier picks the **cheapest capable tier** from `routing.tiers` (cheapest first) by prompt complexity, escalating to more capable tiers on failure. Explicit model names behave exactly as before — plus the fallback chain. Drop-in semantics are preserved; nothing is configured by default.

Every routed request records which provider/model actually served it, whether a fallback was used, and the retry count — queryable via `GET /traces?fallbackUsed=true` (and `?routedProvider=`). Streaming requests fail over up to the first chunk; once the SSE response is committed, a mid-stream error is surfaced as an inline event.

## Development

```bash
pnpm verify       # typecheck + lint + tests with coverage (the pre-PR gate)
pnpm test:watch   # tests in watch mode
pnpm dev          # run the gateway with reload
```

See [`CLAUDE.md`](./CLAUDE.md) for the full command list, coding standards, and contribution workflow, and [`ROADMAP.md`](./ROADMAP.md) for what's next.
