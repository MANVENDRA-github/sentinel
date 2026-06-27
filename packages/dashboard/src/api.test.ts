import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchTraces, fetchRegression } from './api';
import type { ApiConfig } from './api';

const config: ApiConfig = { baseUrl: 'http://gw', adminKey: 'admin' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api client', () => {
  it('fetchTraces sends the admin bearer and parses JSON', async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify([{ id: 'a' }]), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const traces = await fetchTraces(config, 10);

    expect(traces).toEqual([{ id: 'a' }]);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('http://gw/traces?limit=10');
    expect(call[1].headers).toEqual({ authorization: 'Bearer admin' });
  });

  it('fetchRegression hits /regression', async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response('[]', { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchRegression(config)).toEqual([]);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://gw/regression');
  });

  it('throws on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('nope', { status: 401, statusText: 'Unauthorized' })),
      ),
    );
    await expect(fetchTraces(config)).rejects.toThrow(/401/);
  });
});
