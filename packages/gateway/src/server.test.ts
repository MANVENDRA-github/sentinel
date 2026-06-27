import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

function buildTestServer(
  registry: ProviderRegistry,
  opts: { store?: TraceStore; adminKey?: string } = {},
) {
  return buildServer({
    registry,
    apiKeys: new Set(['good']),
    logger: false,
    traceStore: opts.store ?? new InMemoryTraceStore(),
    adminKey: opts.adminKey,
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
});
