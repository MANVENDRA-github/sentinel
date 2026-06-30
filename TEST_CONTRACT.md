# TEST_CONTRACT.md — verification strategy

This is a binding contract, not a guideline. Sentinel is infrastructure in the request path; untested behavior here breaks every app behind it. This repo follows a **proof-first** ethos — that standard applies to every change.

## The rule: TDD is mandatory

**No production code is written without a failing test that requires it.** Red → green → refactor, every time.

1. Write the test that captures the desired behavior.
2. Run it; **watch it fail** for the right reason.
3. Write the minimum code to pass.
4. Refactor with the test green.

A PR whose diff adds or changes behavior without a corresponding test that would **fail without it** is incomplete. Reviewers reject it.

## Tooling

| Layer | Tool | Scope |
|---|---|---|
| Unit | **Vitest** | Pure logic: cache-key / similarity math, routing decisions, guardrail verdicts, token-bucket. No I/O. |
| Integration | **Vitest** + Fastify **`.inject()`** | The HTTP surface with providers / Redis / Ollama **mocked or faked**. Request → route → cache → verify → response. |
| Contract | **Vitest** + recorded fixtures | Provider adapters against **recorded** real responses (record once, replay in CI). Catches provider-shape drift. |
| E2E | **Playwright** (+ **Playwright MCP**) | Dashboard flows against a seeded gateway. Agent-driven exploratory passes via Playwright MCP. |
| Load | **Node harness** (`load/run.ts`) | Throughput, p99 overhead, 429-elimination, cost-reduction numbers. |

## Determinism rules (CI must be hermetic)

- **No live network or LLM calls in unit/integration tests.** Providers, Redis, and the Ollama judge are mocked/faked. Live calls are non-deterministic, slow, cost money, and rate-limit CI.
- **Record/replay** real provider responses as fixtures for contract tests; never hit the live API in CI.
- The **judge** (an LLM) is mocked to return fixed verdicts in tests; judge *prompt construction* and *verdict parsing* are tested deterministically — the model itself is not.
- No `Date.now()` / randomness in assertions without injection — pass clocks/seeds in.

## What must be tested (critical paths — non-negotiable)

- **Proxy fidelity:** OpenAI-compatible request in → correct shape out, streaming and non-streaming.
- **Routing:** each complexity tier → expected model; fallback on error/timeout/429.
- **Cache:** miss → provider call + write; hit (above threshold) → no provider call; below threshold → miss.
- **Rate-limit survival:** throttle holds under the limit; 429 triggers backoff/fallback; **the client never sees an unhandled 429**.
- **Guardrails:** valid passes; malformed / schema-violating / policy-violating is flagged or blocked; **fail-closed** (a guardrail error blocks, never passes).
- **Judge:** sampling rate respected; verdict parsed and attached to the trace; judge failure degrades to "unscored", never to "passed".
- **Auth & isolation:** missing/invalid Sentinel key rejected; one key cannot read another's cache/traces.
- **Redaction:** provider keys and un-redacted prompt content never appear in logs/traces (assert on the log output).

## Coverage & gates

- Coverage thresholds enforced in CI (start **90% lines/branches** on `packages/gateway/`; never ratchet down).
- **CI gate = `pnpm verify`** (typecheck + lint + test + coverage). A red gate blocks merge. No `--no-verify`; no skipped tests left in `main` (a quarantined test needs a linked issue + a date).
- Each ROADMAP phase ships its tests **and** captured evidence (green CI run / test transcript) — proof, not assertion.

## Conventions

- Test files: `*.test.ts` next to source (unit + integration); `packages/dashboard/e2e/**` (Playwright).
- One behavior per test; name as `describe('feature') > it('does X when Y')`.
- Arrange–Act–Assert; no logic in tests; shared fixtures in `test/fixtures/`.
