# ROADMAP.md — Phased build blueprint

A modular, sequential build. **Work one phase at a time.** Each phase is sized to fit a single LLM context window: it names the *only* files/dirs you should load and change, ships something runnable, and has explicit exit criteria. Do not start phase N+1 until phase N's exit criteria are green and merged.

> **Status — 2026-06-28: COMPLETE.** All build phases (0–7) are done and shipped as **[v0.1.0](https://github.com/MANVENDRA-github/sentinel/releases/tag/v0.1.0)**. Two places the build diverged from this original blueprint: Phase 7's load test is a self-contained **Node harness** (`pnpm load`) rather than k6 — the local Ollama is broken, so it runs against mock upstreams — and it shipped as **v0.1.0**, not v1.0. Phase 8 (fine-tuned judge) remains optional/deferred. Measured numbers live in `PRP_SPEC.md` §5 and the README's Benchmarks section.

> For each phase: read `PRP_SPEC.md` (capability IDs C1–C8), fill `PLAN_TEMPLATE.md`, follow `TEST_CONTRACT.md` (test-first), and log any high-risk work in `SECURITY_REVIEW_LOG.md`.

---

## Phase 0 — Foundation & tooling
**Goal:** an empty but fully-wired monorepo that lints, type-checks, tests, and runs in CI.
**Context:** root config only — `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `eslint.config.js`, `.prettierrc`, `vitest.config.ts`, `.github/workflows/ci.yml`, `docker-compose.yml`, `.env.example`.
**Deliverables:** pnpm workspace; strict TS; ESLint + Prettier; Vitest with one trivial passing test; `pnpm verify` script; CI green; docker-compose for Redis + Ollama; `pnpm ollama:pull` (qwen2.5 + nomic-embed-text).
**Exit:** `pnpm verify` and CI green on a fresh clone; `docker compose up` starts Redis + Ollama.

## Phase 1 — Pass-through proxy (C1, C2)
**Goal:** an OpenAI-compatible proxy that forwards to one real provider, streaming and non-streaming.
**Context:** `packages/gateway/` only — Fastify server, one provider adapter (start with Ollama or Gemini), Zod request/response schemas, pino logging.
**Deliverables:** `POST /v1/chat/completions` (stream + non-stream) forwarding to a configured provider; provider keys from env, redacted in logs; minimal Sentinel API-key auth (C8 minimal); request/response validated by Zod.
**Exit:** an unmodified OpenAI-SDK client gets a correct completion through Sentinel by changing only `baseURL`; unit + integration tests (mocked provider) green.

## Phase 2 — Tracing & persistence (C7)
**Goal:** every request is observable.
**Context:** `packages/gateway/telemetry/` + a storage module.
**Deliverables:** OpenTelemetry spans per request (provider, model, tokens, latency, status); trace persistence (better-sqlite3 dev / Postgres prod); a read API (`GET /traces`). No UI yet.
**Exit:** every proxied call produces a queryable trace; tests assert span/record shape.

## Phase 3 — Semantic cache (C4)
**Goal:** serve semantically-similar repeats without a provider call.
**Context:** `packages/gateway/cache/` + embeddings via Ollama (`nomic-embed-text`) + Redis vector (in-memory fallback for tests).
**Deliverables:** prompt embedding, vector similarity lookup, configurable threshold + TTL, cache write on miss; trace records `cacheHit`.
**Exit:** measurable hit-rate on a repeated/similar workload; latency of a hit ≪ a miss; tests cover hit / miss / threshold.

## Phase 4 — Routing, fallback & rate-limit survival (C3, C5)
**Goal:** cheapest-capable routing and no unhandled 429s.
**Context:** `packages/gateway/router/` + `packages/gateway/limits/`.
**Deliverables:** complexity classifier (rules first, model later); cost-aware route map; provider fallback on error/timeout/429; token-bucket throttle (Redis); retry/backoff; round-robin across multiple keys/providers; local-Ollama fallback.
**Exit:** a load test exceeding one free-tier limit yields **zero unhandled 429s** to the client; routing decisions are traced and tested.

## Phase 5 — Verification: guardrails + judge (C6)
**Goal:** catch bad outputs — inline deterministic, async judge.
**Context:** `packages/gateway/verify/`.
**Deliverables:** inline deterministic guardrails (valid JSON, Zod schema match, policy/PII), fail-closed, optional inline block; async LLM-judge (Ollama `qwen2.5`) on sampled traffic producing a 1–5 score + reason; verdict persisted to the trace; regression tracking across prompt/model versions.
**Exit:** injected bad outputs are caught at a measured rate; inline path stays under the p99 budget (judge is async/sampled); tests cover pass / flag / block and a mocked judge.

## Phase 6 — Dashboard
**Goal:** see cost, reliability, cache, and quality at a glance.
**Context:** `packages/dashboard/` (React + Vite + TS), reading the Phase 2 trace API.
**Deliverables:** views for traces, cost over time, cache hit-rate, route distribution, quality scores/verdicts, regressions.
**Exit:** Playwright E2E covers the core views against seeded data.

## Phase 7 — Hardening, load test & launch
**Goal:** prove the numbers; ship it.
**Context:** `e2e/`, `load/` (k6), `README.md`, docs.
**Deliverables:** k6 load test; measured cost-reduction %, p99 overhead, 429-elimination, quality catch-rate (fills `PRP_SPEC.md` §5); full security pass (`SECURITY_REVIEW_LOG.md`); README + quickstart; OSS release.
**Exit:** headline metrics captured and documented; security checklist complete; v1.0 tagged.

## Phase 8 — (Advanced, optional) Fine-tuned judge
**Goal:** a sharper, cheaper judge — and the model-internals milestone.
**Context:** `training/` (separate, Python) + the existing Ollama judge slot.
**Deliverables:** QLoRA/DPO a small judge model on collected (response, verdict) data; quantize; serve via Ollama/vLLM; A/B vs the base local judge and a frontier judge.
**Exit:** the tuned judge matches/beats the base local judge at lower cost/latency, swapped in by config.

---

### Working notes
- **One phase = one context window.** Load only the phase's named dirs. If a task needs files from another phase's dir, that's a signal the phase boundary is wrong — flag it, don't quietly sprawl.
- **Each phase ends runnable and merged.** No phase leaves the build red.
- Capability IDs (C1–C8) refer to `PRP_SPEC.md` §4.
