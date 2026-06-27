# SECURITY_REVIEW_LOG.md — adversarial audit & high-risk change log

Sentinel sits in the request path of every LLM call, **holds provider API keys**, and processes **untrusted prompt/response content**. That makes it a high-value target. This file is the running security memory of the project: a new session (human or agent) should read it to learn where the sharp edges are and what's already been reviewed.

**The rule:** any change touching a **high-risk area** (below) requires (1) a `PLAN_TEMPLATE.md` "Security impact" section, and (2) a dated entry in the log table — _before_ merge. Treat all prompt and response content as hostile. Default to fail-closed.

## Threat model (one paragraph)

Abuse vectors: a malicious or compromised client behind the gateway; untrusted prompt content trying to hijack the judge or exfiltrate data via traces; a malicious provider/endpoint (SSRF, poisoned responses); another tenant trying to read cached/traced data; supply-chain risk in dependencies. The gateway must protect **provider keys**, **tenant isolation**, and **its own availability**, and must never leak secrets or one tenant's data to another.

## High-risk areas — adversarial checklist

Each item: assume an attacker is actively trying it. Tick only when a test proves the defense.

### 1. Secret / key management

- [x] Provider keys loaded only from env/secret store; never hard-coded, never in the repo.
- [ ] Keys never written to logs, traces, error messages, or the dashboard (redaction tested).
- [x] Client-facing errors never echo upstream auth headers.
- [x] `.env`/secrets in `.gitignore`; `.env.example` has placeholders only.

### 2. Prompt-injection & judge integrity

- [ ] Prompt/response content treated as untrusted data, never as instructions to Sentinel.
- [ ] The LLM-judge prompt isolates the content under review (delimited/structured) so a response can't talk the judge into "pass"; judge failure ⇒ "unscored", never "passed".
- [ ] Guardrails cannot be disabled by request content.

### 3. AuthN / AuthZ / tenant isolation

- [x] Every request authenticated by a Sentinel API key; invalid/missing ⇒ 401.
- [ ] Cache entries and traces namespaced per key; cross-tenant read is impossible (tested).
- [x] Admin/config endpoints separated from proxy traffic and authorized distinctly.

### 4. SSRF / outbound calls

- [x] Provider base URLs come from a config allow-list, not from request input.
- [ ] Redirects to other hosts are not blindly followed.

### 5. Cache poisoning / data leakage

- [x] Cache key includes everything that changes the answer (model, params, stream, embed-model) — a different context cannot collide into a wrong hit.
- [x] No cross-tenant cache hits (entries bucketed by API-key hash); the similarity threshold cannot leak another key's data.

### 6. Log / trace data hygiene

- [x] Traces are metadata-only — prompt/response bodies are never persisted; API keys stored as a SHA-256 hash, never raw.
- [ ] Stored trace content is escaped on render in the dashboard (no stored XSS).

### 7. Availability / DoS

- [ ] Sentinel's own rate-limits/quotas protect it from a runaway client.
- [ ] Bounded queues/timeouts; a slow provider cannot exhaust the event loop or memory.

### 8. Supply chain

- [ ] Dependencies pinned; `pnpm audit` clean (or triaged) in CI.
- [ ] No post-install scripts from untrusted packages.

## Pre-launch (Phase 7) gate

- [ ] All high-risk items above ticked, with tests.
- [ ] `pnpm audit` triaged; secrets scan clean.
- [ ] An adversarial review pass with **fresh context** — re-derive the attack, don't trust the author's framing (the cold-gatekeeper pattern).

## Review log

| ID     | Date       | Area (1–8) | Change / PR                    | Risk                                                                         | Severity | Status    | Mitigation / notes                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | ---------- | ---------- | ------------------------------ | ---------------------------------------------------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —      | 2026-06-27 | —          | Initial context docs (no code) | n/a                                                                          | n/a      | n/a       | Baseline.                                                                                                                                                                                                                                                                                                                                                                                         |
| SR-001 | 2026-06-27 | 1, 3, 4    | Phase 1 pass-through proxy     | Unauthenticated access; key/secret leakage; SSRF via request-controlled URLs | high     | mitigated | Bearer Sentinel-key auth required — 401 on missing/invalid (tested). Provider keys read from env via `apiKeyEnv`, never hard-coded, never returned to clients. Provider base URLs come only from the config file, never request input. `authorization`/`x-api-key` redacted in request logs via pino `redact` (configured; an explicit log-assertion test is still TODO — box 1.2 left unticked). |
| SR-002 | 2026-06-27 | 3, 6       | Phase 2 tracing & persistence  | Unauthorized trace access; secrets/PII in stored traces                      | high     | mitigated | `GET /traces` gated by a separate `SENTINEL_ADMIN_KEY` — 401 without it (tested), distinct from client keys. Traces are metadata-only (model, provider, tokens, latency, status) — no prompt/response bodies persisted. API keys stored as a SHA-256 hash, never raw. Per-key trace scoping deferred (admin-only for now).                                                                        |
| SR-003 | 2026-06-27 | 5          | Phase 3 semantic cache         | Cross-tenant cache leakage; wrong-answer collisions                          | high     | mitigated | Cache entries are bucketed per-tenant by API-key hash — no cross-tenant hits (tested). The bucket also keys on model/temperature/max_tokens/stream/embed-model, so requests that change the answer never collide; semantic matching happens only within a bucket above a conservative threshold (0.92, configurable). Cache fails open (embed errors → miss).                                     |

> Add a row per high-risk change. Status ∈ {open, mitigated, accepted}. Severity ∈ {low, med, high, critical}.
