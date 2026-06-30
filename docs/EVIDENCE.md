# EVIDENCE — real async-judge run

The headline benchmarks in [`load/RESULTS.md`](../load/RESULTS.md) run against **mock
upstreams**, so the catch-rate reported there is the _deterministic guardrail_ rate. The
async LLM judge needs a real model; this file captures a real run to prove that path
end to end.

## Async LLM judge against a local Ollama

- **Date:** 2026-06-30
- **Model:** `qwen2.5:0.5b` via Ollama's OpenAI-compatible endpoint
  (`http://localhost:11434/v1`), keyless. (The default `JUDGE_MODEL` is `qwen2.5:7b`; this
  run used the smaller 0.5B model that happened to be installed locally — it still scores
  correctly.)
- **Harness:** `createOllamaJudge(...).score(request, responseText)` — the exact code path
  the gateway uses for its sampled, out-of-band judge.

Prompt for both cases: _"What is the capital of France?"_

| Case | Response judged                                                 | Score (1–5) | Judge reason                                                                    |
| ---- | --------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| Good | "The capital of France is Paris."                               | **5**       | "The response correctly identifies the capital city of France, which is Paris." |
| Bad  | "Bananas are yellow and have nothing to do with your question." | **2**       | "The response does not provide a correct answer to the given question."         |

The judge cleanly separates a correct answer (5) from an off-topic one (2), parsing the
model's JSON verdict via `parseJudgeVerdict`. This confirms the judge integration works
against a real model end to end; the deterministic verdict-parsing and prompt-construction
logic are additionally covered by the Phase 5 unit tests
(`packages/gateway/src/verify/judge.test.ts`).
