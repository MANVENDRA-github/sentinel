# Changelog

All notable changes to Sentinel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Per-request **cost tracking**: set a `pricing` map (USD per 1K tokens, per model) in `sentinel.config.json` and every trace records a `costUsd`; the dashboard shows total spend, spend saved by the cache, and cost over time.
- **Native Anthropic provider**: set `"type": "anthropic"` on a provider and Sentinel speaks Anthropic's Messages API (`x-api-key`, request/response/stream translation) while clients keep using the OpenAI shape.
- **Multi-key round-robin**: a provider can list `apiKeyEnvs` (a key pool); Sentinel rotates across the keys per request to spread load and survive free-tier rate limits.

### Fixed

- The gateway production build (`pnpm build`) no longer pulls dashboard sources into the Node build; CI now runs `pnpm build` on every PR so it can't silently break again.

### Changed

- Documentation-accuracy pass: corrected stack/roadmap references (Node load harness, not k6; single-node in-memory cache + SQLite storage; dashboard is shipped; providers are OpenAI-compatible with native Anthropic planned), reconciled `package.json` versions to `0.1.0`, and added a **Known limitations** section to the README.

## [0.1.0] — 2026-06-28

First public release: a self-hostable, OpenAI-compatible **verifying LLM gateway** that
routes, semantically caches, and verifies every call, with full OpenTelemetry tracing and a
dashboard. Adopting it is a one-line base-URL change.

### Proxy & providers

- Drop-in OpenAI-compatible `POST /v1/chat/completions`, streaming and non-streaming.
- Bearer auth for callers; provider keys held server-side and never exposed to clients.
- Unified `openai-compatible` provider — OpenAI, Groq, Mistral, OpenRouter, DeepSeek, xAI, Google Gemini (OpenAI endpoint), and local Ollama — selected by config, not code.

### Routing & resilience

- Ordered candidate chain with retry + exponential backoff and fail-over to configured fallback models, ending at a local model so a request can always be served.
- Per-provider token-bucket throttling to stay under each provider's `rpm`; terminal errors (400/401/403/404) fail fast without pointless fallback.
- Opt-in cost-aware routing: `"model": "auto"` picks the cheapest capable tier by prompt complexity, escalating on failure.

### Semantic cache

- Local prompt embeddings (Ollama `nomic-embed-text`) with cosine-similarity lookup; hits are served without a provider call, replaying buffered SSE for streamed requests.
- Per-tenant isolation (scoped to the calling key), bounded by TTL + max-entries, and fail-open on any embedding error.

### Verification

- Inline deterministic guardrails (JSON validity + schema, and a PII/policy engine: emails, Luhn-checked cards, SSNs, phones, IPs, API-key-like tokens, content blocklist, refusal detection). Flagged by default; `GUARDRAILS_BLOCK=true` returns 422; always fails closed.
- Async local LLM-as-judge scoring sampled responses out of band (no added latency), with prompt-injection-resistant wrapping and "unscored" on failure.
- Regression tracking: a model-independent prompt fingerprint groups judge scores by `(prompt, model)` via `GET /regression`.

### Observability

- OpenTelemetry trace per request (provider, model, status, latency, tokens, cache hit, fallback, verdict), persisted to SQLite (or in-memory) and queryable via an admin-gated `GET /traces` with filters; optional OTLP export.
- Traces are metadata-only — no prompt or response bodies; API keys recorded as SHA-256 hashes.
- Read-only React + Vite dashboard aggregating the trace API client-side.

### Security & operations

- Per-client rate limiting (`CLIENT_RPM`) keyed by hashed API key — a single noisy key gets 429s without affecting other clients.
- Upstream fetches refuse redirects (SSRF hardening); authorization headers redacted from logs.
- CI runs typecheck + lint + the full coverage gate plus a production dependency audit. Security posture tracked in `SECURITY_REVIEW_LOG.md`.
- Reproducible load harness (`pnpm load`) producing the headline benchmarks in `load/RESULTS.md`: 50% cache cost-reduction on a 50%-repeat workload, zero unhandled 429s, 100% PII guardrail catch-rate, and ~14 ms p99 added overhead (measured in-process against **mock upstreams**; the catch-rate is the deterministic-guardrail rate — see `load/RESULTS.md` for full method and caveats).

[0.1.0]: https://github.com/MANVENDRA-github/sentinel/releases/tag/v0.1.0
