# CLAUDE.md

Operating guidance for any AI assistant (or human) working on **Sentinel**. Read this first, every session.

The product source of truth is `PRP_SPEC.md`. The build order is `ROADMAP.md`. Before writing code, fill out `PLAN_TEMPLATE.md` in Plan Mode and get it approved. Test rules are binding in `TEST_CONTRACT.md`. Any high-risk change is logged in `SECURITY_REVIEW_LOG.md`.

## Project

**What this is:** Sentinel is a self-hostable **verifying LLM gateway** — a drop-in, OpenAI-compatible proxy that sits between an application and its LLM providers and does three jobs on every request: **routes** (cheapest capable model + automatic fallback), **caches** (semantic cache to cut cost/latency and survive free-tier rate limits), and **verifies** (deterministic guardrails inline + an async local LLM-as-judge) — with full OpenTelemetry tracing and a dashboard. Unlike after-the-fact observability tools, Sentinel can **block or flag a bad response before it returns**. For: developers and small teams running LLM features who need cost control, reliability, and output-quality assurance.

**Stack** (do not introduce alternatives without updating this file):
- Language: **TypeScript 5.x**, `strict: true`, ESM. Runtime: **Node.js ≥ 22 (LTS)**.
- Package manager / monorepo: **pnpm** workspaces.
- Gateway server: **Fastify** (streaming, hooks, `.inject()` testing).
- Schemas & validation: **Zod** at every trust boundary (config, request/response, guardrails).
- Providers: OpenAI-compatible interface (`openai` SDK) with adapters for **OpenAI, Anthropic, Google Gemini (AI Studio), Ollama**.
- Local models (keyless): **Ollama** — judge `qwen2.5:7b`, embeddings `nomic-embed-text`.
- Cache & rate-limit state: **Redis** (`ioredis`); in-memory fallback for dev/tests.
- Storage (traces, eval results): **better-sqlite3** (dev) / **Postgres** (prod).
- Telemetry: **OpenTelemetry** (`@opentelemetry/sdk-node`). Logging: **pino**.
- Tests: **Vitest** (unit/integration), **Playwright** (E2E + Playwright MCP for the dashboard).
- Quality: **ESLint** (flat config, `typescript-eslint` strict) + **Prettier**.
- Infra: **Docker** + docker-compose (gateway + redis + ollama). CI: **GitHub Actions**.
- Dashboard (later phase): **React + Vite + TS**.

**Commands** (the only canonical ones — use these, don't invent):
- Install: `pnpm install`
- Local infra (redis + ollama): `docker compose up -d`, then `pnpm ollama:pull`
- Dev (watch): `pnpm dev`
- Build: `pnpm build`
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint` (fix: `pnpm lint:fix`) · Format: `pnpm format`
- Unit/integration tests: `pnpm test` (watch: `pnpm test:watch`, coverage: `pnpm test:cov`)
- E2E: `pnpm test:e2e`
- **Pre-PR gate (must pass): `pnpm verify`** = typecheck + lint + test + coverage.

**Structure** (target monorepo — build it per `ROADMAP.md`, don't scaffold ahead of the current phase):
- `packages/gateway/` — the Fastify proxy: providers, router, cache, verify (guardrails + judge), telemetry. The core.
- `packages/sdk/` — thin client/config helpers (later phase).
- `packages/dashboard/` — React + Vite UI (later phase).
- Tests: `*.test.ts` next to source (unit); `packages/*/test/` (integration); `e2e/` (Playwright).
- Root docs: `PRP_SPEC.md`, `ROADMAP.md`, `PLAN_TEMPLATE.md`, `TEST_CONTRACT.md`, `SECURITY_REVIEW_LOG.md`.

## Coding style (strict — these are not suggestions)

- **`strict: true` stays on. No `any`.** If a value's shape is unknown, type it `unknown` and narrow with a Zod schema or a type guard. Never `as any`; never double-cast `x as unknown as T` without a runtime check.
- **Silence a type error with `// @ts-expect-error` + a one-line reason — never `// @ts-ignore`, never `// @ts-nocheck`.**
- **Validate at the boundary.** Every inbound request, config file, provider response, and cache hit is parsed through a Zod schema before use. Inside the validated core, trust your types.
- **Fail closed, stay observable.** A verification or provider failure surfaces (logged + traced); it never silently returns a degraded answer as if it were good. No `catch {}` that hides a failure.
- **Functional core, imperative shell.** Pure, testable decision logic (routing, cache-key, guardrail verdicts) separated from I/O (HTTP, Redis, providers, Ollama).
- **Small modules, named exports, no default exports.** Read 2–3 existing files and match their conventions before adding new ones.
- **No secrets in code or logs.** Provider keys come from env/config only and are redacted in every log and trace.

## How to work

**Plan before coding.** For any non-trivial task, fill out `PLAN_TEMPLATE.md` in Plan Mode first — files to change, risks, security impact, test plan — and get it approved before writing code. Read `PRP_SPEC.md` and the relevant `ROADMAP.md` phase so you stay in scope.

**Test-first is mandatory.** See `TEST_CONTRACT.md`. Write a failing test that captures the behavior, watch it fail for the right reason, make it pass, refactor. No production code without a test that would fail without it. No live LLM/network calls in unit tests — mock providers and the Ollama judge.

**Simplicity first.** Minimum code that satisfies the current ROADMAP phase. No speculative abstractions, no features beyond the phase, no error handling for impossible cases. If 200 lines could be 50, write the 50.

**Surgical changes.** Touch only what the task requires. Don't refactor or reformat unrelated code. Every changed line traces to the task. Stay inside the current phase's package/dir.

**Verify, don't assume done.** Run `pnpm verify` before finishing and capture the output. Don't report success on unverified work — this repo follows a proof-first culture, so show the green run.

**Working asynchronously.** When unsupervised, don't stop to ask unless truly blocked — make the most reasonable choice, proceed, and record the assumption in the PLAN and PR body. For anything ambiguous or security-relevant, do what you safely can and surface the risky part clearly rather than guessing.

## Definition of done

Before opening a PR: `pnpm verify` passes (typecheck + lint + tests + coverage gate); new behavior is covered by a test that fails without the change; no stray debug output, commented-out code, or TODOs you introduced; secrets are externalized and redacted; if the change touched a high-risk area, `SECURITY_REVIEW_LOG.md` has an entry; the change does only what the current ROADMAP phase asked.

## Pull requests

One focused PR per task or phase-slice, small and reviewable. Conventional-commit title (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`). Body states: what changed (1–2 sentences), why (the ROADMAP item), how to verify (exact commands), and any assumptions/flags. Write it so it can be approved from a phone without reading every diff line.

## Never

- Never commit secrets, API keys, tokens, or `.env` files.
- Never push directly to `main` — always a feature branch + PR.
- Never use `any`, `// @ts-ignore`, or `as any` to get past the type-checker.
- Never let a unit test hit a live network/LLM endpoint.
- Never log or trace raw provider keys or un-redacted user prompt content.
- Never delete or rewrite files outside the task's scope.
