/*
 * Sentinel load harness (run with `pnpm load`).
 *
 * Reliability over realism: the gateway is built in-process and driven with Fastify
 * `inject`, against two in-process mock upstreams — no real LLM, no flaky local Ollama,
 * no child-process orchestration. It measures Sentinel's OWN behavior:
 *   - cache cost-reduction (deterministic mock embeddings → exact repeats hit the cache)
 *   - per-request overhead (the mock is ~instant, so duration ≈ Sentinel's own time)
 *   - 429-elimination (a flaky always-429 provider → retried + failed over to a healthy one)
 *   - guardrail catch-rate (injected PII → blocked inline)
 *
 * This file is run via tsx and is excluded from lint/typecheck on purpose.
 */
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import {
  loadConfig,
  createRegistry,
  createTraceStore,
  createSemanticCache,
  createOllamaEmbedder,
  createBucketRegistry,
  createVerifier,
  buildServer,
} from '../packages/gateway/src/index.js';
import { initTelemetry } from '../packages/gateway/src/telemetry/otel.js';

const RELIABLE_PORT = 8082;
const FLAKY_PORT = 8081;

let chatCalls = 0;
let embedCalls = 0;

// Deterministic embedding via per-dimension hashing. Identical text → identical vector
// (cosine 1.0 → real cache hit on exact repeats); different text → uncorrelated vectors
// (cosine ≈ 0 → proper miss). A naive positional char-sum collides for similar strings
// ("flaky 0" vs "flaky 1") and would manufacture false cache hits.
function hash32(str, seed) {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // murmur3 finalizer: full avalanche so one-char input differences fully decorrelate.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
function embed(text) {
  const dims = 64;
  const v = new Array(dims);
  for (let d = 0; d < dims; d++) v[d] = (hash32(text, d) / 0xffffffff) * 2 - 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function completion(content) {
  return {
    id: 'mock',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

const reliable = http.createServer(async (req, res) => {
  const body = await readBody(req);
  if (req.url && req.url.startsWith('/embeddings')) {
    embedCalls++;
    const input = JSON.parse(body).input;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ embedding: embed(String(input)) }] }));
    return;
  }
  if (req.url && req.url.startsWith('/chat/completions')) {
    chatCalls++;
    const model = JSON.parse(body).model;
    const content = model === 'pii' ? 'Sure, reach me at agent@example.com anytime.' : 'All good.';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion(content)));
    return;
  }
  res.writeHead(404);
  res.end();
});

const flaky = http.createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(429, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'rate limited' } }));
});

await new Promise((r) => reliable.listen(RELIABLE_PORT, () => r(undefined)));
await new Promise((r) => flaky.listen(FLAKY_PORT, () => r(undefined)));

const config = loadConfig({ path: 'load/load.sentinel.config.json', env: process.env });
const store = createTraceStore({ kind: 'memory' });
const shutdownTelemetry = initTelemetry(store, {});
const cache = createSemanticCache({
  embedder: createOllamaEmbedder({ baseUrl: `http://localhost:${RELIABLE_PORT}`, model: 'mock-embed' }),
  threshold: 0.92,
  ttlMs: 300_000,
  maxEntries: 2000,
  embedModel: 'mock-embed',
});
const throttle = createBucketRegistry({ defaultRpm: 0 });
const verifier = createVerifier({ store, guardrails: { block: true, ...config.guardrails } });
const app = buildServer({
  registry: createRegistry(config),
  apiKeys: new Set(['load-key']),
  traceStore: store,
  adminKey: 'admin',
  cache,
  routing: {
    config: config.routing,
    maxRetries: 1,
    timeoutMs: 5000,
    baseBackoffMs: 5,
    maxWaitMs: 0,
    throttle,
  },
  verifier,
  logger: false,
});

async function call(model, content) {
  const start = performance.now();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer load-key', 'content-type': 'application/json' },
    payload: { model, messages: [{ role: 'user', content }] },
  });
  return { ms: performance.now() - start, status: res.statusCode };
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

console.log('running load scenarios (cache, fallback, guardrails)...');
// Sequential on purpose: the mocks, the gateway, and this driver all share one Node
// event loop, so firing requests concurrently would measure head-of-line blocking, not
// Sentinel's own per-request cost. One-at-a-time gives a true overhead number.
// Warm up JIT, fetch, and telemetry so the measured p99 reflects steady state, not a
// one-off cold start. The `warmup` model is excluded from every metric below.
for (let i = 0; i < 8; i++) await call('warmup', `warmup ${i}`);
chatCalls = 0; // reset mock counters so they reflect only the measured run
embedCalls = 0;
const N = 100;
const prompts = Array.from({ length: N }, (_, i) => `unique load request ${i}`);
const pass1 = [];
for (const p of prompts) pass1.push(await call('std', p)); // unique → cache misses (overhead sample)
const pass2 = [];
for (const p of prompts) pass2.push(await call('std', p)); // exact repeats → cache hits
const flakyRes = [];
for (let i = 0; i < 50; i++) flakyRes.push(await call('svc', `flaky ${i}`)); // always-429 → fallback
const piiRes = [];
for (let i = 0; i < 50; i++) piiRes.push(await call('pii', `pii ${i}`)); // injected PII → blocked

const all = store.query({ limit: 500 });
const measured = all.filter((t) => t.model !== 'warmup'); // drop warmup traces from every metric
const std = measured.filter((t) => t.model === 'std');
const cacheHits = std.filter((t) => t.cacheHit).length;
const costReduction = std.length > 0 ? (cacheHits / std.length) * 100 : 0;

const overhead = std.filter((t) => !t.cacheHit).map((t) => t.durationMs).sort((a, b) => a - b);
const clientLat = [...pass1, ...pass2, ...flakyRes, ...piiRes].map((r) => r.ms).sort((a, b) => a - b);

const client429 = [...pass1, ...pass2, ...flakyRes, ...piiRes].filter((r) => r.status === 429).length;
const fallbacks = measured.filter((t) => t.fallbackUsed).length;
const flaky200 = flakyRes.filter((r) => r.status === 200).length;
const blocked = piiRes.filter((r) => r.status === 422).length;
const catchRate = piiRes.length > 0 ? (blocked / piiRes.length) * 100 : 0;

const rows = [
  ['Total requests', String(measured.length)],
  ['Upstream chat calls (mock)', `${chatCalls} of ${measured.length} requests (cache served ${cacheHits} from memory)`],
  ['Cache cost-reduction (50%-repeat workload)', `${costReduction.toFixed(1)}%  (${cacheHits}/${std.length} served from cache)`],
  ['Gateway overhead p50 / p99', `${pct(overhead, 50).toFixed(2)} ms / ${pct(overhead, 99).toFixed(2)} ms`],
  ['Client latency p99', `${pct(clientLat, 99).toFixed(2)} ms`],
  ['429-elimination', `${client429} unhandled 429s to client (of ${flakyRes.length} always-429 upstream); ${flaky200} succeeded via fallback`],
  ['Fallback used (traces)', String(fallbacks)],
  ['Guardrail catch-rate (injected PII)', `${catchRate.toFixed(0)}%  (${blocked}/${piiRes.length} blocked)`],
];

console.log('\n=== Sentinel load test results ===');
for (const [k, v] of rows) console.log(`${k.padEnd(44)} ${v}`);

const md = `# Load test results

In-process load (Fastify \`inject\`) against mock upstreams — isolates Sentinel's own
behavior and overhead without a real LLM. Reproduce with \`pnpm load\`.

| Metric | Value |
|---|---|
${rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, '/')} |`).join('\n')}

## Framing (honest)

- **Overhead** is Sentinel's own per-request time — the mock upstream is ~instant, so duration ≈ the gateway's work. Not a model's latency.
- **Cost-reduction** is measured on a workload with 50% exact-repeat prompts (the cache's target case). Real savings track your traffic's repeat rate.
- **429-elimination**: every request to a flaky (always-429) provider was retried and **failed over** to a healthy provider, so the client never saw an unhandled 429.
- **Catch-rate** is the **deterministic guardrail** rate on injected PII responses; the async LLM judge (needs a real model) is covered by the Phase 5 unit tests, not here.
`;
writeFileSync('load/RESULTS.md', md);
console.log('\nwrote load/RESULTS.md');

await app.close();
await shutdownTelemetry();
reliable.close();
flaky.close();
process.exit(0);
