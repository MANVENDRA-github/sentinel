# Load test results

In-process load (Fastify `inject`) against mock upstreams — isolates Sentinel's own
behavior and overhead without a real LLM. Reproduce with `pnpm load`.

| Metric | Value |
|---|---|
| Total requests | 300 |
| Upstream chat calls (mock) | 200 of 300 requests (cache served 100 from memory) |
| Cache cost-reduction (50%-repeat workload) | 50.0%  (100/200 served from cache) |
| Gateway overhead p50 / p99 | 7.51 ms / 14.44 ms |
| Client latency p99 | 33.93 ms |
| 429-elimination | 0 unhandled 429s to client (of 50 always-429 upstream); 50 succeeded via fallback |
| Fallback used (traces) | 50 |
| Guardrail catch-rate (injected PII) | 100%  (50/50 blocked) |

## Framing (honest)

- **Overhead** is Sentinel's own per-request time — the mock upstream is ~instant, so duration ≈ the gateway's work. Not a model's latency.
- **Cost-reduction** is measured on a workload with 50% exact-repeat prompts (the cache's target case). Real savings track your traffic's repeat rate.
- **429-elimination**: every request to a flaky (always-429) provider was retried and **failed over** to a healthy provider, so the client never saw an unhandled 429.
- **Catch-rate** is the **deterministic guardrail** rate on injected PII responses; the async LLM judge (needs a real model) is covered by the Phase 5 unit tests, not here.
