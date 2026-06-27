# PLAN_TEMPLATE.md

Copy this template and fill **every** section in Plan Mode **before writing any code**. A plan is approved before implementation starts. Keep it concrete — file paths, not vibes. Delete the angle-bracket guidance as you fill it.

---

## Task
<One sentence: what this change delivers.>

- **ROADMAP phase:** <e.g. Phase 3 — Semantic cache>
- **PRP capability:** <e.g. C4>
- **Issue / branch:** <id / branch name>

## Context to load
<The minimal set of files/dirs to read for this task — ideally only the current phase's dir per ROADMAP. List them. If you need files outside the phase boundary, justify why.>

## Approach
<2–6 sentences. The design decision and why. Name the chosen option and the rejected alternative if non-obvious. Keep it the simplest thing that satisfies the phase.>

## Files to change
| File | New / Modify | What & why |
|---|---|---|
| `packages/gateway/...` | new | <...> |
| `...` | modify | <...> |

<If this list is long or spans multiple phase dirs, the task is too big — split it.>

## Test plan (test-first — see TEST_CONTRACT.md)
<The failing tests you will write FIRST, before implementation. Concrete cases.>
- [ ] `<file>.test.ts` — <given / when / then>
- [ ] integration: <case>
- [ ] (if applicable) e2e / contract: <case>

**Mocks:** <which providers / Redis / Ollama are mocked — no live network in unit tests.>

## Risks & mitigations
| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| <e.g. cache returns another key's data> | <…> | <…> |

## Security impact
<Does this touch a high-risk area (keys, prompt-injection, auth, SSRF, log redaction, cache isolation, dashboard rendering)? If yes: name it and add an entry to `SECURITY_REVIEW_LOG.md` before merging. If no: state "no high-risk surface touched" and why.>

## Verification steps
<Exact commands a reviewer runs, and the expected result.>
- [ ] `pnpm verify` green
- [ ] <specific manual / curl check, with expected output>
- [ ] coverage for new code ≥ threshold

## Rollback
<How to revert safely if this regresses. Usually "revert the PR"; note any data/migration that complicates it.>

## Out of scope
<What this change deliberately does NOT do — to prevent scope creep and reassure the reviewer.>

## Definition of done
- [ ] Failing tests written first, now passing
- [ ] `pnpm verify` green; coverage gate met
- [ ] No `any` / `@ts-ignore` / secrets in logs
- [ ] `SECURITY_REVIEW_LOG.md` updated if high-risk
- [ ] PR body: what / why / how-to-verify / assumptions
