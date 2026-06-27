import { describe, it, expect, vi } from 'vitest';
import { createOpenAICompatibleProvider } from './openai-compatible.js';
import { UpstreamError } from '../errors.js';
import type { ChatCompletionRequest } from '../schemas.js';

const request: ChatCompletionRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

function streamResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe('openai-compatible provider', () => {
  it('sends a non-streaming request and returns the JSON body', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: { headers: Record<string, string>; body: string }) =>
        Promise.resolve(new Response(JSON.stringify({ id: 'x' }), { status: 200 })),
    );
    const provider = createOpenAICompatibleProvider({
      name: 'p',
      baseUrl: 'http://h/v1/',
      apiKey: 'key',
      fetchImpl,
    });

    const result = await provider.chat(request);
    expect(result).toEqual({ id: 'x' });

    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe('http://h/v1/chat/completions');
    expect(call[1].headers.authorization).toBe('Bearer key');
    expect((JSON.parse(call[1].body) as { stream: boolean }).stream).toBe(false);
  });

  it('omits the auth header when no key is set', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: { headers: Record<string, string>; body: string }) =>
        Promise.resolve(new Response('{}', { status: 200 })),
    );
    const provider = createOpenAICompatibleProvider({
      name: 'p',
      baseUrl: 'http://h/v1',
      fetchImpl,
    });

    await provider.chat(request);
    expect(fetchImpl.mock.calls[0]![1].headers.authorization).toBeUndefined();
  });

  it('throws UpstreamError on a non-OK response', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('nope', { status: 500 })));
    const provider = createOpenAICompatibleProvider({ name: 'p', baseUrl: 'http://h', fetchImpl });

    await expect(provider.chat(request)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('parses an SSE stream and stops at [DONE]', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        streamResponse([
          'data: {"a":1}\n\n',
          'data: {"b":2}\n\n',
          'data: [DONE]\n\n',
          'data: {"c":3}\n\n',
        ]),
      ),
    );
    const provider = createOpenAICompatibleProvider({ name: 'p', baseUrl: 'http://h', fetchImpl });

    const out: string[] = [];
    for await (const payload of provider.chatStream(request)) out.push(payload);
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('throws UpstreamError when a streaming response has no body', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const provider = createOpenAICompatibleProvider({ name: 'p', baseUrl: 'http://h', fetchImpl });
    await expect(
      (async () => {
        for await (const _chunk of provider.chatStream(request)) {
          // drain
        }
      })(),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it('omits the auth header when the key is an empty string', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: { headers: Record<string, string>; body: string }) =>
        Promise.resolve(new Response('{}', { status: 200 })),
    );
    const provider = createOpenAICompatibleProvider({
      name: 'p',
      baseUrl: 'http://h',
      apiKey: '',
      fetchImpl,
    });
    await provider.chat(request);
    expect(fetchImpl.mock.calls[0]![1].headers.authorization).toBeUndefined();
  });

  it('ignores SSE comment lines and events without a data field', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        streamResponse([': keep-alive\n\n', 'data: {"a":1}\n\n', 'data: [DONE]\n\n']),
      ),
    );
    const provider = createOpenAICompatibleProvider({ name: 'p', baseUrl: 'http://h', fetchImpl });
    const out: string[] = [];
    for await (const payload of provider.chatStream(request)) out.push(payload);
    expect(out).toEqual(['{"a":1}']);
  });
});
