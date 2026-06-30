import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import { buildServer, logRedaction } from './server.js';
import type { Provider } from './providers/types.js';
import type { ProviderRegistry } from './providers/registry.js';
import { InMemoryTraceStore } from './telemetry/store.memory.js';
import { createBucketRegistry } from './throttle/token-bucket.js';
import { createOpenAICompatibleProvider } from './providers/openai-compatible.js';
import { hashApiKey } from './auth.js';
import type { ChatCompletionRequest } from './schemas.js';
import type { TraceRecord } from './telemetry/trace.js';

const provider: Provider = {
  name: 'fake',
  chat: () => Promise.resolve({ id: 'cmpl', choices: [], usage: { total_tokens: 1 } }),
  chatStream: async function* () {
    yield '{}';
  },
};
const registry: ProviderRegistry = { resolve: () => provider };
const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const url = '/v1/chat/completions';

describe('per-client rate limiting (CLIENT_RPM)', () => {
  it('429s a single key past its budget but leaves other keys unaffected', async () => {
    const app = buildServer({
      registry,
      apiKeys: new Set(['good', 'other']),
      logger: false,
      traceStore: new InMemoryTraceStore(),
      clientThrottle: createBucketRegistry({ defaultRpm: 1 }),
    });
    const a1 = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer good' },
      payload: body,
    });
    expect(a1.statusCode).toBe(200);
    const a2 = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer good' },
      payload: body,
    });
    expect(a2.statusCode).toBe(429);
    expect(a2.json().error.code).toBe('rate_limited');
    const b1 = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer other' },
      payload: body,
    });
    expect(b1.statusCode).toBe(200);
    await app.close();
  });

  it('does not rate-limit when no clientThrottle is configured', async () => {
    const app = buildServer({
      registry,
      apiKeys: new Set(['good']),
      logger: false,
      traceStore: new InMemoryTraceStore(),
    });
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: 'Bearer good' },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });
});

describe('log redaction', () => {
  it('redacts the authorization header (logRedaction), never the raw key', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const app = buildServer({
      registry,
      apiKeys: new Set(['supersecret']),
      traceStore: new InMemoryTraceStore(),
      logger: {
        redact: logRedaction,
        stream,
        // A serializer that keeps headers, so the redact paths have something to act on
        // (Fastify's default req serializer omits headers entirely — keys never reach the log).
        serializers: { req: (r: { headers: unknown }) => ({ headers: r.headers }) },
      },
    });
    app.log.info({ req: { headers: { authorization: 'Bearer supersecret' } } }, 'probe');
    await app.close();
    const log = lines.join('');
    expect(log).toContain('[redacted]');
    expect(log).not.toContain('supersecret');
  });
});

describe('upstream redirect hardening', () => {
  it('sends redirect: error so a prompt is never followed to another host', async () => {
    const fetchMock = vi.fn((_url: string, _init: { redirect?: string }) =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    const p = createOpenAICompatibleProvider({
      name: 'p',
      baseUrl: 'http://h',
      fetchImpl: fetchMock,
    });
    const request: ChatCompletionRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    };
    await p.chat(request);
    expect(fetchMock.mock.calls[0]![1].redirect).toBe('error');
  });
});

function traceRec(id: string, apiKeyHash: string): TraceRecord {
  return {
    id,
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
    costUsd: null,
    errorType: null,
    errorMessage: null,
    apiKeyHash,
    cacheHit: false,
    routedProvider: null,
    routedModel: null,
    fallbackUsed: false,
    retryCount: 0,
    guardrailStatus: null,
    guardrailViolations: null,
    judgeScore: null,
    judgeReason: null,
    judgeError: null,
    promptFingerprint: null,
  };
}

describe('self-scoped /v1/traces isolation', () => {
  it("returns only the caller's own traces and never another key's", async () => {
    const store = new InMemoryTraceStore();
    store.record(traceRec('mine', hashApiKey('good')));
    store.record(traceRec('theirs', hashApiKey('other')));
    const app = buildServer({
      registry,
      apiKeys: new Set(['good', 'other']),
      logger: false,
      traceStore: store,
      adminKey: 'admin',
    });

    const mine = await app.inject({
      method: 'GET',
      url: '/v1/traces',
      headers: { authorization: 'Bearer good' },
    });
    expect(mine.statusCode).toBe(200);
    expect((mine.json() as { id: string }[]).map((t) => t.id)).toEqual(['mine']);

    const theirs = await app.inject({
      method: 'GET',
      url: '/v1/traces',
      headers: { authorization: 'Bearer other' },
    });
    expect((theirs.json() as { id: string }[]).map((t) => t.id)).toEqual(['theirs']);

    // No key → 401.
    expect((await app.inject({ method: 'GET', url: '/v1/traces' })).statusCode).toBe(401);

    // A key cannot fetch another key's trace by id (404, not another tenant's data).
    const cross = await app.inject({
      method: 'GET',
      url: '/v1/traces/theirs',
      headers: { authorization: 'Bearer good' },
    });
    expect(cross.statusCode).toBe(404);

    // ...but can fetch its own by id.
    const own = await app.inject({
      method: 'GET',
      url: '/v1/traces/mine',
      headers: { authorization: 'Bearer good' },
    });
    expect(own.statusCode).toBe(200);
    await app.close();
  });
});
