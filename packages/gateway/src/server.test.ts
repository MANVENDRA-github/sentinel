import { describe, it, expect } from 'vitest';
import { buildServer } from './server.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { Provider } from './providers/types.js';
import { ModelNotFoundError, UpstreamError } from './errors.js';

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

function buildTestServer(registry: ProviderRegistry) {
  return buildServer({ registry, apiKeys: new Set(['good']), logger: false });
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
    const app = buildServer({ registry, apiKeys: new Set(['good']), logger: false });
    const res = await app.inject({ method: 'POST', url, headers: auth, payload: body });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.type).toBe('internal_error');
    await app.close();
  });

  it('uses a redacting logger by default', async () => {
    const app = buildServer({ registry: makeRegistry(makeProvider()), apiKeys: new Set(['good']) });
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
