import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { buildServer } from './server.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { Provider } from './providers/types.js';
import { ModelNotFoundError, UpstreamError } from './errors.js';
import { InMemoryTraceStore } from './telemetry/store.memory.js';
import type { TraceStore } from './telemetry/trace.js';
import { TraceStoreSpanExporter } from './telemetry/exporter.js';
import { createSemanticCache } from './cache/cache.js';
import type { SemanticCache } from './cache/cache.js';
import type { Embedder } from './cache/embedder.js';
import { createVerifier } from './verify/verifier.js';
import type { Judge } from './verify/judge.js';

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    name: 'fake',
    chat: () => Promise.resolve({ id: 'cmpl', choices: [] }),
    chatStream: async function* () {
      yield '{"delta":1}';
      yield '{"delta":2}';
    },
    ...overrides,
  };
}

function makeRegistry(provider: Provider, opts: { unknownModel?: boolean } = {}): ProviderRegistry {
  return {
    resolve(model) {
      if (opts.unknownModel === true) throw new ModelNotFoundError(model);
      return provider;
    },
  };
}

function makeMultiRegistry(map: Record<string, Provider>): ProviderRegistry {
  return {
    resolve(model) {
      const provider = map[model];
      if (provider === undefined) throw new ModelNotFoundError(model);
      return provider;
    },
  };
}

function buildTestServer(
  registry: ProviderRegistry,
  opts: { store?: TraceStore; adminKey?: string; cache?: SemanticCache } = {},
) {
  return buildServer({
    registry,
    apiKeys: new Set(['good']),
    logger: false,
    traceStore: opts.store ?? new InMemoryTraceStore(),
    adminKey: opts.adminKey,
    cache: opts.cache,
  });
}

const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const auth = { authorization: 'Bearer good' };
const url = '/v1/chat/completions';

describe('POST /v1/chat/completions', () => {
  it('rejects a missing or bad API key with 401', async () => {
    const app = buildTestServer(makeRegistry(makeProvider()));
    const noKey = await app.inject({ method: 'POST', url, payload: body });
    expect(noKey.statusCode).toBe(401);
    const badKey = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer nope' },
      payload: body,
    });
    expect(badKey.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an invalid body with 400', async () => {
    const app = buildTestServer(makeRegistry(makeProvider()));
    const res = await app.inject({ method: 'POST', url, headers: auth, payload: { messages: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
    await app.close();
  });

  it('forwards a non-streaming completion', async () => {
    const app = buildTestServer(makeRegistry(makeProvider()));
    const res = await app.inject({ method: 'POST', url, headers: auth, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'cmpl', choices: [] });
    await app.close();
  });

  it('streams an SSE response ending with [DONE]', async () => {
    const app = buildTestServer(makeRegistry(makeProvider()));
    const res = await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { ...body, stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('data: {"delta":1}');
    expect(res.body).toContain('data: [DONE]');
    await app.close();
  });

  it('maps an unknown model to 404', async () => {
    const app = buildTestServer(makeRegistry(makeProvider(), { unknownModel: true }));
    const res = await app.inject({ method: 'POST', url, headers: auth, payload: body });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('maps a non-streaming upstream failure to its status', async () => {
    const provider = makeProvider({
      chat: () => Promise.reject(new UpstreamError('p', 429, 'rate limited')),
    });
    const app = buildTestServer(makeRegistry(provider));
    const res = await app.inject({ method: 'POST', url, headers: auth, payload: body });
    expect(res.statusCode).toBe(429);
    await app.close();
  });

  it('maps a streaming failure before headers are sent to a proper status', async () => {
    const provider = makeProvider({
      // eslint-disable-next-line require-yield
      chatStream: async function* () {
        throw new UpstreamError('p', 503, 'down');
      },
    });
    const app = buildTestServer(makeRegistry(provider));
    const res = await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { ...body, stream: true },
    });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it('emits an inline error event if the stream fails after it starts', async () => {
    const provider = makeProvider({
      chatStream: async function* () {
        yield '{"ok":1}';
        throw new UpstreamError('p', 500, 'mid-stream boom');
      },
    });
    const app = buildTestServer(makeRegistry(provider));
    const res = await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { ...body, stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('{"ok":1}');
    expect(res.body).toContain('upstream_error');
    await app.close();
  });

  it('fails closed with 500 on an unexpected (non-gateway) error', async () => {
    const registry: ProviderRegistry = {
      resolve() {
        throw new Error('boom');
      },
    };
    const app = buildServer({
      registry,
      apiKeys: new Set(['good']),
      logger: false,
      traceStore: new InMemoryTraceStore(),
    });
    const res = await app.inject({ method: 'POST', url, headers: auth, payload: body });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.type).toBe('internal_error');
    await app.close();
  });

  it('uses a redacting logger by default', async () => {
    const app = buildServer({
      registry: makeRegistry(makeProvider()),
      apiKeys: new Set(['good']),
      traceStore: new InMemoryTraceStore(),
    });
    const res = await app.inject({ method: 'POST', url, headers: auth, payload: body });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects a non-object JSON body with 400', async () => {
    const app = buildTestServer(makeRegistry(makeProvider()));
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '"just a string"',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('emits an internal_error event if the stream fails with a non-gateway error', async () => {
    const provider = makeProvider({
      chatStream: async function* () {
        yield '{"ok":1}';
        throw new Error('unexpected');
      },
    });
    const app = buildTestServer(makeRegistry(provider));
    const res = await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { ...body, stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('internal_error');
    await app.close();
  });
});

describe('routing, fallback & throttle', () => {
  it('falls back to a healthy provider on a retryable upstream error', async () => {
    const primary = makeProvider({
      name: 'primary',
      chat: () => Promise.reject(new UpstreamError('primary', 429, 'rate limited')),
    });
    const fb = makeProvider({ name: 'fb', chat: (req) => Promise.resolve({ served: req.model }) });
    const app = buildServer({
      registry: makeMultiRegistry({ primary, fb }),
      apiKeys: new Set(['good']),
      logger: false,
      traceStore: new InMemoryTraceStore(),
      routing: { config: { fallback: ['fb'] }, maxRetries: 0, sleep: () => Promise.resolve() },
    });
    const res = await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { ...body, model: 'primary' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ served: 'fb' });
    await app.close();
  });

  it('routes model:"auto" to the classified cheapest tier', async () => {
    const cheap = makeProvider({
      name: 'cheap',
      chat: (req) => Promise.resolve({ served: req.model }),
    });
    const big = makeProvider({
      name: 'big',
      chat: (req) => Promise.resolve({ served: req.model }),
    });
    const app = buildServer({
      registry: makeMultiRegistry({ cheap, big }),
      apiKeys: new Set(['good']),
      logger: false,
      traceStore: new InMemoryTraceStore(),
      routing: { config: { tiers: ['cheap', 'big'] } },
    });
    const res = await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ served: 'cheap' });
    await app.close();
  });

  it('skips a throttled provider and falls back', async () => {
    const primary = makeProvider({
      name: 'primary',
      chat: () => Promise.resolve({ served: 'primary' }),
    });
    const fb = makeProvider({ name: 'fb', chat: () => Promise.resolve({ served: 'fb' }) });
    const throttle = { acquire: (provider: string) => Promise.resolve(provider !== 'primary') };
    const app = buildServer({
      registry: makeMultiRegistry({ primary, fb }),
      apiKeys: new Set(['good']),
      logger: false,
      traceStore: new InMemoryTraceStore(),
      routing: { config: { fallback: ['fb'] }, throttle },
    });
    const res = await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { ...body, model: 'primary' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ served: 'fb' });
    await app.close();
  });

  it('does not fall back on a terminal (4xx) upstream error', async () => {
    let fbCalls = 0;
    const primary = makeProvider({
      name: 'primary',
      chat: () => Promise.reject(new UpstreamError('primary', 400, 'bad request')),
    });
    const fb = makeProvider({
      name: 'fb',
      chat: () => {
        fbCalls += 1;
        return Promise.resolve({ served: 'fb' });
      },
    });
    const app = buildServer({
      registry: makeMultiRegistry({ primary, fb }),
      apiKeys: new Set(['good']),
      logger: false,
      traceStore: new InMemoryTraceStore(),
      routing: { config: { fallback: ['fb'] }, maxRetries: 2, sleep: () => Promise.resolve() },
    });
    const res = await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { ...body, model: 'primary' },
    });
    expect(res.statusCode).toBe(400);
    expect(fbCalls).toBe(0);
    await app.close();
  });

  it('falls back when the primary stream fails on its first chunk', async () => {
    const primary = makeProvider({
      name: 'primary',
      // eslint-disable-next-line require-yield
      chatStream: async function* () {
        throw new UpstreamError('primary', 503, 'down');
      },
    });
    const fb = makeProvider({
      name: 'fb',
      chatStream: async function* () {
        yield '{"d":"fb"}';
      },
    });
    const app = buildServer({
      registry: makeMultiRegistry({ primary, fb }),
      apiKeys: new Set(['good']),
      logger: false,
      traceStore: new InMemoryTraceStore(),
      routing: { config: { fallback: ['fb'] }, maxRetries: 0, sleep: () => Promise.resolve() },
    });
    const res = await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { ...body, model: 'primary', stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('{"d":"fb"}');
    await app.close();
  });
});

describe('inline guardrails', () => {
  const guarded = (content: string, block: boolean) => {
    const store = new InMemoryTraceStore();
    const provider = makeProvider({
      chat: () => Promise.resolve({ choices: [{ message: { role: 'assistant', content } }] }),
    });
    return buildServer({
      registry: makeRegistry(provider),
      apiKeys: new Set(['good']),
      logger: false,
      traceStore: store,
      verifier: createVerifier({ store, guardrails: { block } }),
    });
  };

  it('blocks a violating response with 422 when blocking is enabled', async () => {
    const app = guarded('reach me at a@b.com', true);
    const res = await app.inject({ method: 'POST', url, headers: auth, payload: body });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.type).toBe('guardrail_blocked');
    await app.close();
  });

  it('passes a clean response through even with blocking enabled', async () => {
    const app = guarded('all good here', true);
    const res = await app.inject({ method: 'POST', url, headers: auth, payload: body });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('tracing & /traces', () => {
  const sink = new InMemoryTraceStore();
  let provider: NodeTracerProvider | undefined;

  beforeAll(() => {
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new TraceStoreSpanExporter(sink))],
    });
    provider.register();
  });

  afterAll(async () => {
    trace.disable();
    await provider?.shutdown();
  });

  it('records a trace for a completed request', async () => {
    const chatProvider = makeProvider({
      chat: () =>
        Promise.resolve({
          id: 'cmpl',
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
        }),
    });
    const app = buildTestServer(makeRegistry(chatProvider), { store: sink });
    await app.inject({ method: 'POST', url, headers: auth, payload: body });
    await app.close();

    const traces = sink.query();
    expect(traces.length).toBeGreaterThanOrEqual(1);
    const last = traces[0];
    expect(last?.model).toBe('m');
    expect(last?.provider).toBe('fake');
    expect(last?.status).toBe(200);
    expect(last?.promptTokens).toBe(5);
    expect(last?.completionTokens).toBe(7);
  });

  it('requires the admin key on /traces', async () => {
    const app = buildTestServer(makeRegistry(makeProvider()), {
      store: sink,
      adminKey: 'admin-secret',
    });
    const noKey = await app.inject({ method: 'GET', url: '/traces' });
    expect(noKey.statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'GET',
      url: '/traces',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'GET',
      url: '/traces',
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(ok.json())).toBe(true);
    await app.close();
  });

  it('serves a single trace by id and 404s unknown ids', async () => {
    const seeded = new InMemoryTraceStore();
    seeded.record({
      id: 'span-xyz',
      traceId: 't',
      timestamp: 1,
      durationMs: 1,
      model: 'm',
      provider: 'p',
      stream: false,
      status: 200,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorType: null,
      errorMessage: null,
      apiKeyHash: null,
      cacheHit: false,
      routedProvider: 'p',
      routedModel: 'm',
      fallbackUsed: false,
      retryCount: 0,
      guardrailStatus: null,
      guardrailViolations: null,
      judgeScore: null,
      judgeReason: null,
      judgeError: null,
      promptFingerprint: null,
    });
    const app = buildTestServer(makeRegistry(makeProvider()), {
      store: seeded,
      adminKey: 'admin-secret',
    });
    const found = await app.inject({
      method: 'GET',
      url: '/traces/span-xyz',
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(found.statusCode).toBe(200);
    expect(found.json().id).toBe('span-xyz');
    const missing = await app.inject({
      method: 'GET',
      url: '/traces/nope',
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('applies query filters on /traces', async () => {
    const store = new InMemoryTraceStore();
    const base = {
      traceId: 't',
      durationMs: 1,
      provider: 'p',
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorType: null,
      errorMessage: null,
      apiKeyHash: null,
      cacheHit: false,
      routedProvider: 'p',
      routedModel: 'm',
      fallbackUsed: false,
      retryCount: 0,
      guardrailStatus: null,
      guardrailViolations: null,
      judgeScore: null,
      judgeReason: null,
      judgeError: null,
      promptFingerprint: null,
    };
    store.record({ ...base, id: 's1', timestamp: 100, model: 'm1', stream: false, status: 200 });
    store.record({ ...base, id: 's2', timestamp: 200, model: 'm2', stream: true, status: 500 });
    const app = buildTestServer(makeRegistry(makeProvider()), { store, adminKey: 'admin-secret' });

    const res = await app.inject({
      method: 'GET',
      url: '/traces?model=m2&status=500&stream=true&since=150&until=250&limit=10&offset=0',
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('s2');
    await app.close();
  });

  it('marks cache hits in the trace', async () => {
    const cache = createSemanticCache({
      embedder: { embed: () => Promise.resolve([1, 0, 0]) },
      threshold: 0.9,
      ttlMs: 60_000,
      maxEntries: 100,
      embedModel: 'e',
    });
    const app = buildTestServer(makeRegistry(makeProvider()), { store: sink, cache });
    const payload = { ...body, model: 'cachetest' };
    await app.inject({ method: 'POST', url, headers: auth, payload });
    await app.inject({ method: 'POST', url, headers: auth, payload });
    await app.close();
    expect(sink.query({ cacheHit: true, model: 'cachetest' }).length).toBeGreaterThanOrEqual(1);
  });

  it('records routing metadata and supports the fallbackUsed filter', async () => {
    const primary = makeProvider({
      name: 'primary',
      chat: () => Promise.reject(new UpstreamError('primary', 429, 'rate limited')),
    });
    const fb = makeProvider({ name: 'fb', chat: (req) => Promise.resolve({ served: req.model }) });
    const app = buildServer({
      registry: makeMultiRegistry({ primary, fb }),
      apiKeys: new Set(['good']),
      logger: false,
      traceStore: sink,
      adminKey: 'admin-secret',
      routing: { config: { fallback: ['fb'] }, maxRetries: 0, sleep: () => Promise.resolve() },
    });
    await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { ...body, model: 'primary' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/traces?fallbackUsed=true&routedProvider=fb',
      headers: { authorization: 'Bearer admin-secret' },
    });
    await app.close();
    const rows = res.json() as {
      fallbackUsed: boolean;
      routedProvider: string;
      routedModel: string;
    }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.fallbackUsed).toBe(true);
    expect(rows[0]?.routedProvider).toBe('fb');
    expect(rows[0]?.routedModel).toBe('fb');
  });

  const replyWith = (content: string): Provider =>
    makeProvider({
      chat: () => Promise.resolve({ choices: [{ message: { role: 'assistant', content } }] }),
    });

  it('flags a guardrail violation on the trace but still returns 200', async () => {
    const verifier = createVerifier({ store: sink, guardrails: { block: false } });
    const app = buildServer({
      registry: makeRegistry(replyWith('mail me at a@b.com')),
      apiKeys: new Set(['good']),
      logger: false,
      traceStore: sink,
      verifier,
    });
    const res = await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { ...body, model: 'guardflag' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
    const record = sink.query({ model: 'guardflag' })[0];
    expect(record?.guardrailStatus).toBe('flag');
    expect(record?.guardrailViolations).toContain('pii.email');
    expect(record?.promptFingerprint).not.toBeNull();
  });

  it('records a judge verdict on the trace', async () => {
    const judge: Judge = { score: () => Promise.resolve({ score: 5, reason: 'great' }) };
    const verifier = createVerifier({ store: sink, judge, shouldSample: () => true });
    const app = buildServer({
      registry: makeRegistry(replyWith('4')),
      apiKeys: new Set(['good']),
      logger: false,
      traceStore: sink,
      verifier,
    });
    await app.inject({ method: 'POST', url, headers: auth, payload: { ...body, model: 'judged' } });
    await verifier.drain();
    await app.close();
    const record = sink.query({ model: 'judged' })[0];
    expect(record?.judgeScore).toBe(5);
    expect(record?.judgeReason).toBe('great');
  });

  it('records "unscored" when the judge fails', async () => {
    const judge: Judge = { score: () => Promise.reject(new Error('down')) };
    const verifier = createVerifier({ store: sink, judge, shouldSample: () => true });
    const app = buildServer({
      registry: makeRegistry(replyWith('4')),
      apiKeys: new Set(['good']),
      logger: false,
      traceStore: sink,
      verifier,
    });
    await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { ...body, model: 'judgefail' },
    });
    await verifier.drain();
    await app.close();
    const record = sink.query({ model: 'judgefail' })[0];
    expect(record?.judgeScore).toBeNull();
    expect(record?.judgeError).toBe('down');
  });

  it('judges a streamed response after it completes', async () => {
    const provider = makeProvider({
      chatStream: async function* () {
        yield 'keep-alive-noise';
        yield JSON.stringify({ choices: [{ delta: { content: 'hello' } }] });
      },
    });
    const judge: Judge = { score: vi.fn(() => Promise.resolve({ score: 4, reason: 'ok' })) };
    const verifier = createVerifier({ store: sink, judge, shouldSample: () => true });
    const app = buildServer({
      registry: makeRegistry(provider),
      apiKeys: new Set(['good']),
      logger: false,
      traceStore: sink,
      verifier,
    });
    const res = await app.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { ...body, model: 'streamjudge', stream: true },
    });
    expect(res.statusCode).toBe(200);
    await verifier.drain();
    await app.close();
    expect(judge.score).toHaveBeenCalledWith(expect.anything(), 'hello');
    const record = sink.query({ model: 'streamjudge' })[0];
    expect(record?.judgeScore).toBe(4);
    expect(record?.promptFingerprint).not.toBeNull();
  });

  it('serves regression aggregates over judged traces', async () => {
    const seeded = new InMemoryTraceStore();
    const base = {
      traceId: 't',
      durationMs: 1,
      provider: 'p',
      stream: false,
      status: 200,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorType: null,
      errorMessage: null,
      apiKeyHash: null,
      cacheHit: false,
      routedProvider: null,
      routedModel: null,
      fallbackUsed: false,
      retryCount: 0,
      guardrailStatus: null,
      guardrailViolations: null,
      judgeReason: null,
      judgeError: null,
    };
    seeded.record({
      ...base,
      id: 'r1',
      timestamp: 1,
      model: 'a',
      judgeScore: 4,
      promptFingerprint: 'fp',
    });
    seeded.record({
      ...base,
      id: 'r2',
      timestamp: 2,
      model: 'b',
      judgeScore: 2,
      promptFingerprint: 'fp',
    });
    const app = buildTestServer(makeRegistry(makeProvider()), {
      store: seeded,
      adminKey: 'admin-secret',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/regression?promptFingerprint=fp&model=a&since=0',
      headers: { authorization: 'Bearer admin-secret' },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it('parses the verification query filters on /traces', async () => {
    const app = buildTestServer(makeRegistry(makeProvider()), {
      store: new InMemoryTraceStore(),
      adminKey: 'admin-secret',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/traces?guardrailStatus=flag&judgeScoreMin=1&judgeScoreMax=5&promptFingerprint=fp',
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    await app.close();
  });
});

describe('semantic cache', () => {
  const fixedEmbedder: Embedder = { embed: () => Promise.resolve([1, 0, 0]) };
  const makeCache = (embedder: Embedder = fixedEmbedder): SemanticCache =>
    createSemanticCache({
      embedder,
      threshold: 0.9,
      ttlMs: 60_000,
      maxEntries: 100,
      embedModel: 'e',
    });

  it('serves a cached non-streaming response without calling the provider again', async () => {
    let calls = 0;
    const provider = makeProvider({
      chat: () => {
        calls += 1;
        return Promise.resolve({ id: 'cmpl', calls });
      },
    });
    const app = buildTestServer(makeRegistry(provider), { cache: makeCache() });
    const first = await app.inject({ method: 'POST', url, headers: auth, payload: body });
    const second = await app.inject({ method: 'POST', url, headers: auth, payload: body });
    expect(first.json()).toEqual({ id: 'cmpl', calls: 1 });
    expect(second.json()).toEqual({ id: 'cmpl', calls: 1 });
    expect(calls).toBe(1);
    await app.close();
  });

  it('replays a cached streaming response', async () => {
    let calls = 0;
    const provider = makeProvider({
      chatStream: async function* () {
        calls += 1;
        yield '{"d":1}';
        yield '{"d":2}';
      },
    });
    const app = buildTestServer(makeRegistry(provider), { cache: makeCache() });
    const payload = { ...body, stream: true };
    const first = await app.inject({ method: 'POST', url, headers: auth, payload });
    const second = await app.inject({ method: 'POST', url, headers: auth, payload });
    expect(first.body).toContain('data: {"d":1}');
    expect(second.body).toContain('data: {"d":1}');
    expect(second.body).toContain('data: [DONE]');
    expect(calls).toBe(1);
    await app.close();
  });

  it('does not share cached answers across API keys', async () => {
    let calls = 0;
    const provider = makeProvider({
      chat: () => {
        calls += 1;
        return Promise.resolve({ id: 'x', calls });
      },
    });
    const app = buildServer({
      registry: makeRegistry(provider),
      apiKeys: new Set(['k1', 'k2']),
      logger: false,
      traceStore: new InMemoryTraceStore(),
      cache: makeCache(),
    });
    await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer k1' },
      payload: body,
    });
    await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer k2' },
      payload: body,
    });
    expect(calls).toBe(2);
    await app.close();
  });

  it('fails open when the embedder errors', async () => {
    const cache = makeCache({ embed: () => Promise.reject(new Error('embed down')) });
    const app = buildTestServer(makeRegistry(makeProvider()), { cache });
    const res = await app.inject({ method: 'POST', url, headers: auth, payload: body });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
