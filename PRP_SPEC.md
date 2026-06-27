# PRP_SPEC.md — Product Requirements & Purpose

> **Source of truth.** When code and this document disagree, this document wins until it is deliberately changed. Every feature traces back to a requirement here. If a requirement isn't here, it's out of scope (see §6).

## 1. Purpose

Sentinel is a self-hostable **verifying LLM gateway**: a drop-in, OpenAI-compatible proxy that sits between an application and its LLM provider(s) and makes LLM traffic **cheaper, more reliable, and verifiable** — without the application changing more than its base URL.

The wedge: existing gateways and observability tools (LiteLLM, Helicone, Langfuse) route or log **after the fact**. Sentinel treats **output correctness as a first-class, in-path concern** — it can score, flag, or block a bad response *before it reaches the user*, using deterministic checks inline and a local LLM-as-judge asynchronously.

## 2. Core problems we solve

1. **Cost is uncontrolled.** Apps call one expensive model for everything. → Route each request to the cheapest *capable* model; serve semantically-similar repeats from cache.
2. **LLM calls are unreliable.** Providers rate-limit (especially free tiers), time out, and fail. → Token-bucket pacing, retry/backoff, multi-key/provider load-spread, and local-model fallback so the app stops seeing 429s and outages.
3. **Output quality is invisible until production.** Teams don't know when a model returns malformed, off-topic, or wrong answers. → Inline deterministic guardrails (schema/format/policy) + an async judge that scores sampled responses, with regression tracking across prompt/model versions.
4. **LLM behavior is unobservable.** `print()`-debugging of prompts, cost, and latency. → Full OpenTelemetry tracing of every call, surfaced in a dashboard.

## 3. Target audience

- **Primary — the indie/solo AI developer on free tiers.** Building agents/apps on Gemini AI Studio, Groq, etc.; constantly hitting rate limits and quality cliffs; wants reliability and visibility without paying for a SaaS. (This is the maintainer's own use case.)
- **Secondary — a small team shipping an LLM feature to production.** Needs cost caps, provider fallback, and a quality gate before bad output reaches customers, self-hosted for data control.
- **Non-audience:** large orgs needing multi-region HA at scale (v1 is single-node, self-hosted); end users who want a chat UI (this is infrastructure, not an app).

## 4. Core capabilities (what it must do)

- **C1 — Drop-in proxy.** OpenAI-compatible `/v1/chat/completions` (streaming + non-streaming). One-line client change (`baseURL`).
- **C2 — Provider abstraction.** Unified interface over OpenAI, Anthropic, Gemini, Ollama; provider/model swappable by config, not code.
- **C3 — Routing & fallback.** Classify request complexity; route to the configured cheapest-capable model; fall back on error/timeout/429.
- **C4 — Semantic cache.** Embed prompts locally (Ollama), look up by vector similarity, serve hits without a provider call; configurable similarity threshold + TTL.
- **C5 — Rate-limit survival.** Token-bucket throttling under provider limits, retry/backoff, round-robin across multiple keys/providers, local-model fallback.
- **C6 — Verification.** Deterministic guardrails inline (valid JSON, schema match, policy/PII), fail-closed; async LLM-as-judge (local Ollama) scoring sampled responses; regression tracking across versions.
- **C7 — Observability.** OpenTelemetry trace per request (provider, model, tokens, cost, latency, cache hit, verdict); persisted and queryable; dashboard.
- **C8 — Auth & isolation.** Per-app Sentinel API keys; provider keys held server-side, never exposed to clients; cache/trace isolation per key.

## 5. Success criteria (the metrics this project must produce)

- **Drop-in:** an existing OpenAI-SDK app works against Sentinel with only a base-URL change.
- **Cost:** demonstrated **50% spend reduction** on a workload with 50% repeated prompts via the semantic cache — 100 of 200 requests served from memory with zero upstream calls (headline number for the case study; routing adds further savings on mixed-capability workloads).
- **Reliability:** **zero unhandled 429s** to the client — measured 0 of 50 requests to an always-429 upstream reached the client; every one was retried and **failed over** to a healthy provider.
- **Quality gate:** **100% catch-rate** of injected PII bad outputs, at **< 15 ms p99 added overhead** (measured ~14 ms; p50 ~7.5 ms) on the inline path.
- **Observability:** every request traceable end-to-end in the dashboard.

These are real measured numbers from the load harness (`pnpm load` → `load/RESULTS.md`). Honest framing: overhead is Sentinel's *own* per-request time against a near-instant mock upstream (not a model's latency); cost-reduction is on a 50%-repeat workload (real savings track your traffic's repeat rate); the quality catch-rate is the **deterministic guardrail** rate — the async LLM judge needs a real model and is covered by the Phase 5 unit tests.

## 6. Scope boundaries (explicit)

**In scope (v1):** the eight capabilities above; self-hosted single-node deployment; local keyless verification/embeddings via Ollama; a minimal dashboard.

**Out of scope (v1) — do not build these without changing this doc:**
- Not a **model host / inference engine** (it *fronts* Ollama/vLLM, doesn't reimplement them).
- Not an **agent framework / orchestration runtime** (it sits *under* agents — the maintainer's existing agents become its clients).
- Not a **prompt IDE / playground**.
- Not a **fine-tuning / training platform** (a fine-tuned judge is a *later, optional* ROADMAP milestone, served through the same Ollama slot).
- Not a **hosted multi-tenant SaaS** with billing, SSO, multi-region HA.
- Not a **vector DB / RAG framework** (the semantic cache is internal infra, not a user-facing retrieval product).

## 7. Guiding principles

- **Fail closed, stay observable.** A verification or provider failure surfaces; it never silently passes a bad answer through.
- **Keyless by default for verification.** Judge + embeddings run locally on Ollama so they never consume the user's provider quota.
- **Proof over assertion.** Every capability ships with a test/eval and captured evidence.
- **Drop-in or it doesn't ship.** If adopting Sentinel costs more than a base-URL change, the design is wrong.
- **Config over code.** Providers, routes, thresholds, and policies are configuration.

## 8. Glossary

- **Guardrail** — a deterministic, inline check on a response (schema/format/policy). Cheap; runs on every request.
- **Judge** — a local LLM (Ollama `qwen2.5`) that scores response quality asynchronously on sampled traffic.
- **Verdict** — the combined pass / flag / block result of guardrails (+ judge).
- **Route** — the chosen provider + model for a request.
- **Trace** — the OpenTelemetry record of one request's journey through the gateway.
