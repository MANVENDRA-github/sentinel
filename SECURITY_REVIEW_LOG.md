# SECURITY_REVIEW_LOG.md — adversarial audit & high-risk change log

Sentinel sits in the request path of every LLM call, **holds provider API keys**, and processes **untrusted prompt/response content**. That makes it a high-value target. This file is the running security memory of the project: a new session (human or agent) should read it to learn where the sharp edges are and what's already been reviewed.

**The rule:** any change touching a **high-risk area** (below) requires (1) a `PLAN_TEMPLATE.md` "Security impact" section, and (2) a dated entry in the log table — _before_ merge. Treat all prompt and response content as hostile. Default to fail-closed.

## Threat model (one paragraph)

Abuse vectors: a malicious or compromised client behind the gateway; untrusted prompt content trying to hijack the judge or exfiltrate data via traces; a malicious provider/endpoint (SSRF, poisoned responses); another tenant trying to read cached/traced data; supply-chain risk in dependencies. The gateway must protect **provider keys**, **tenant isolation**, and **its own availability**, and must never leak secrets or one tenant's data to another.

## High-risk areas — adversarial checklist

Each item: assume an attacker is actively trying it. Tick only when a test proves the defense.

### 1. Secret / key management

- [x] Provider keys loaded only from env/secret store; never hard-coded, never in the repo.
- [x] Keys never written to logs, traces, error messages, or the dashboard (redaction tested).
- [x] Client-facing errors never echo upstream auth headers.
- [x] `.env`/secrets in `.gitignore`; `.env.example` has placeholders only.

### 2. Prompt-injection & judge integrity

- [x] Prompt/response content treated as untrusted data, never as instructions to Sentinel.
- [x] The LLM-judge prompt isolates the content under review (delimited/structured) so a response can't talk the judge into "pass"; judge failure ⇒ "unscored", never "passed".
- [x] Guardrails cannot be disabled by request content.

### 3. AuthN / AuthZ / tenant isolation

- [x] Every request authenticated by a Sentinel API key; invalid/missing ⇒ 401.
- [x] Cache entries and traces namespaced per key; cross-tenant read is impossible (tested).
- [x] Admin/config endpoints separated from proxy traffic and authorized distinctly.

### 4. SSRF / outbound calls

- [x] Provider base URLs come from a config allow-list, not from request input.
- [x] Redirects to other hosts are not blindly followed.

### 5. Cache poisoning / data leakage

- [x] Cache key includes everything that changes the answer (model, params, stream, embed-model) — a different context cannot collide into a wrong hit.
- [x] No cross-tenant cache hits (entries bucketed by API-key hash); the similarity threshold cannot leak another key's data.

### 6. Log / trace data hygiene

- [x] Traces are metadata-only — prompt/response bodies are never persisted; API keys stored as a SHA-256 hash, never raw.
- [x] Stored trace content is escaped on render in the dashboard (no stored XSS).

### 7. Availability / DoS

- [x] Sentinel's own rate-limits/quotas protect it from a runaway client.
- [x] Bounded queues/timeouts; a slow provider cannot exhaust the event loop or memory.

### 8. Supply chain

- [x] Dependencies pinned; `pnpm audit` clean (or triaged) in CI.
- [x] No post-install scripts from untrusted packages.

## Pre-launch (Phase 7) gate

- [x] All high-risk items above ticked, with tests.
- [x] `pnpm audit` triaged; secrets scan clean.
- [x] An adversarial review pass with **fresh context** — Phase 7 ran two independent cold-context Explore audits that re-derived each box's defense (or gap) directly from the code, with file:line citations, rather than trusting the author's framing.

## Review log

| ID     | Date       | Area (1–8) | Change / PR                               | Risk                                                                                                                                                         | Severity | Status    | Mitigation / notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | ---------- | ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —      | 2026-06-27 | —          | Initial context docs (no code)            | n/a                                                                                                                                                          | n/a      | n/a       | Baseline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| SR-001 | 2026-06-27 | 1, 3, 4    | Phase 1 pass-through proxy                | Unauthenticated access; key/secret leakage; SSRF via request-controlled URLs                                                                                 | high     | mitigated | Bearer Sentinel-key auth required — 401 on missing/invalid (tested). Provider keys read from env via `apiKeyEnv`, never hard-coded, never returned to clients. Provider base URLs come only from the config file, never request input. `authorization`/`x-api-key` redacted in request logs via pino `redact` (configured; an explicit log-assertion test is still TODO — box 1.2 left unticked).                                                                                                                                                                                                                                                                                   |
| SR-002 | 2026-06-27 | 3, 6       | Phase 2 tracing & persistence             | Unauthorized trace access; secrets/PII in stored traces                                                                                                      | high     | mitigated | `GET /traces` gated by a separate `SENTINEL_ADMIN_KEY` — 401 without it (tested), distinct from client keys. Traces are metadata-only (model, provider, tokens, latency, status) — no prompt/response bodies persisted. API keys stored as a SHA-256 hash, never raw. Per-key trace scoping deferred (admin-only for now).                                                                                                                                                                                                                                                                                                                                                          |
| SR-003 | 2026-06-27 | 5          | Phase 3 semantic cache                    | Cross-tenant cache leakage; wrong-answer collisions                                                                                                          | high     | mitigated | Cache entries are bucketed per-tenant by API-key hash — no cross-tenant hits (tested). The bucket also keys on model/temperature/max_tokens/stream/embed-model, so requests that change the answer never collide; semantic matching happens only within a bucket above a conservative threshold (0.92, configurable). Cache fails open (embed errors → miss).                                                                                                                                                                                                                                                                                                                       |
| SR-004 | 2026-06-27 | 7          | Phase 4 routing & fallback                | Self-inflicted DoS: unbounded retries/fallback amplify load; a slow or hostile provider stalls the event loop; throttle/router as a new untrusted-input path | med      | mitigated | Each attempt is bounded by a per-attempt `AbortController` timeout (`REQUEST_TIMEOUT_MS`) so a slow provider can't hang the loop (tested). Retries are capped (`MAX_RETRIES`) and fallback walks a finite, **config-defined** candidate chain — request input never adds providers/URLs (no new SSRF surface). A per-provider token bucket paces outbound calls to each provider's `rpm`, protecting upstreams and avoiding self-induced 429 storms. Terminal 4xx errors fail fast without amplification. Inbound per-client rate-limiting (box 7.1) is still deferred.                                                                                                             |
| SR-005 | 2026-06-27 | 2          | Phase 5 verification (guardrails + judge) | Prompt-injection via response content talking the judge into a "pass"; PII/secrets leaking into traces via verdicts; request content disabling guardrails    | high     | mitigated | Boxes 2.1–2.3 ticked (tested). Guardrails/judge treat prompt+response as **data**, never instructions — only regex/JSON inspection, no eval. The judge prompt wraps the response behind explicit delimiters and labels it untrusted DATA; the verdict is parsed solely from the judge's own JSON output, so an injected `{"score":5}` in the response can't set the score (tested); a judge failure ⇒ "unscored" (null), **never** a pass. Guardrail policy comes only from env/config file, never the request body. Traces persist violation **category codes** (`pii.email`) — never the matched PII/secret value. Inline guardrails fail **closed**: a check that throws blocks. |

| SR-006 | 2026-06-27 | 1, 4, 7, 8 | Phase 7 hardening & launch | Key leakage to logs; SSRF via upstream redirect; self-inflicted DoS from a runaway client; supply-chain advisories | high | mitigated | Box 1.2: `logRedaction` redacts `authorization`/`x-api-key`; a test proves the header logs as `[redacted]` and the raw key never appears (Fastify's default serializer also omits headers, so keys can't leak by default). Box 4.2: the upstream `fetch` uses `redirect: 'error'` — a malicious provider can't 3xx-redirect the prompt to another host (tested). Box 7.1: a per-API-key inbound token bucket (`CLIENT_RPM`) returns 429 when one key exceeds its budget, without affecting other clients (tested). Box 8.1: CI runs `pnpm audit --prod --audit-level=high` and production deps are clean; the only advisories are dev-only (vitest/vite test tooling, never shipped), triaged and tracked for a vitest 3 upgrade. Boxes 3.2/6.2/8.2 ticked from existing coverage (cache per-tenant isolation tests; React-escaped, metadata-only dashboard; no untrusted post-install scripts). |

| SR-007 | 2026-06-30 | 1, 4 | PR3 native Anthropic adapter | A second outbound auth path (`x-api-key`) and a new response/stream shape: risk of leaking the Anthropic key to logs, following a malicious redirect, or trusting a malformed upstream body | high | mitigated | The Anthropic key is sent only in the outbound `x-api-key` header — never logged (`logRedaction` already redacts inbound `x-api-key`; Fastify omits request headers by default) and never returned to clients; it comes from `ANTHROPIC_API_KEY` via `apiKeyEnv`, never hard-coded. The adapter reuses `redirect: 'error'`, so a malicious provider can't 3xx the prompt to another host (tested), and the base URL still comes only from the config allow-list, never request input. The Anthropic response is parsed through a Zod schema before translation; an unexpected shape ⇒ `UpstreamError` (502), never a malformed pass-through (tested). |

> Add a row per high-risk change. Status ∈ {open, mitigated, accepted}. Severity ∈ {low, med, high, critical}.
