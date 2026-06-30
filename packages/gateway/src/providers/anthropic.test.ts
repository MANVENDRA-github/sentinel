import { describe, it, expect, vi } from 'vitest';
import { createAnthropicProvider } from './anthropic.js';
import { UpstreamError } from '../errors.js';
import type { ChatCompletionRequest } from '../schemas.js';

const request: ChatCompletionRequest = {
  model: 'claude-3-5-sonnet',
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'hi' },
  ],
  max_tokens: 100,
  temperature: 0.5,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

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

const reply = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-3-5-sonnet',
  content: [{ type: 'text', text: 'Hello there' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 12, output_tokens: 5 },
};

describe('anthropic provider', () => {
  it('translates an OpenAI request into an Anthropic Messages request', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: { headers: Record<string, string>; body: string }) =>
        Promise.resolve(jsonResponse(reply)),
    );
    const provider = createAnthropicProvider({
      name: 'anthropic',
      baseUrl: 'http://h/v1/',
      apiKey: 'key',
      fetchImpl,
    });

    await provider.chat(request);

    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe('http://h/v1/messages');
    expect(call[1].headers['x-api-key']).toBe('key');
    expect(call[1].headers['anthropic-version']).toBe('2023-06-01');
    expect(call[1].headers.authorization).toBeUndefined();
    const body = JSON.parse(call[1].body) as {
      model: string;
      max_tokens: number;
      system?: string;
      temperature?: number;
      messages: { role: string; content: string }[];
      stream?: boolean;
    };
    expect(body.model).toBe('claude-3-5-sonnet');
    expect(body.max_tokens).toBe(100);
    expect(body.system).toBe('Be brief.'); // system message hoisted out of messages
    expect(body.temperature).toBe(0.5);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.stream).toBeUndefined();
  });

  it('maps the Anthropic response into the OpenAI chat-completion shape', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(reply)));
    const provider = createAnthropicProvider({ name: 'anthropic', baseUrl: 'http://h', fetchImpl });

    const result = (await provider.chat(request)) as {
      object: string;
      model: string;
      choices: { message: { role: string; content: string }; finish_reason: string | null }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(result.object).toBe('chat.completion');
    expect(result.model).toBe('claude-3-5-sonnet');
    expect(result.choices[0]?.message).toEqual({ role: 'assistant', content: 'Hello there' });
    expect(result.choices[0]?.finish_reason).toBe('stop'); // end_turn → stop
    expect(result.usage).toEqual({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
  });

  it('defaults max_tokens when the caller omits it, and maps max_tokens → length', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: { headers: Record<string, string>; body: string }) =>
        Promise.resolve(jsonResponse({ ...reply, stop_reason: 'max_tokens' })),
    );
    const provider = createAnthropicProvider({ name: 'anthropic', baseUrl: 'http://h', fetchImpl });

    const result = (await provider.chat({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    })) as { choices: { finish_reason: string | null }[] };

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body) as { max_tokens: number };
    expect(body.max_tokens).toBe(4096);
    expect(result.choices[0]?.finish_reason).toBe('length');
  });

  it('omits x-api-key when no key is set', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: { headers: Record<string, string>; body: string }) =>
        Promise.resolve(jsonResponse(reply)),
    );
    const provider = createAnthropicProvider({ name: 'anthropic', baseUrl: 'http://h', fetchImpl });
    await provider.chat(request);
    expect(fetchImpl.mock.calls[0]![1].headers['x-api-key']).toBeUndefined();
  });

  it('throws UpstreamError on a non-OK response', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('overloaded', { status: 529 })));
    const provider = createAnthropicProvider({ name: 'anthropic', baseUrl: 'http://h', fetchImpl });
    await expect(provider.chat(request)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('throws UpstreamError when the response shape is unexpected', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ content: 'not-an-array' })));
    const provider = createAnthropicProvider({ name: 'anthropic', baseUrl: 'http://h', fetchImpl });
    await expect(provider.chat(request)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('translates an Anthropic SSE stream into OpenAI chunks', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        streamResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
      ),
    );
    const provider = createAnthropicProvider({ name: 'anthropic', baseUrl: 'http://h', fetchImpl });

    const chunks: { choices: { delta: { content?: string }; finish_reason: string | null }[] }[] =
      [];
    for await (const payload of provider.chatStream(request)) {
      chunks.push(JSON.parse(payload));
    }
    // message_start and message_stop are dropped; two text deltas + one finish chunk remain.
    expect(chunks).toHaveLength(3);
    const text = chunks.map((c) => c.choices[0]?.delta.content ?? '').join('');
    expect(text).toBe('Hello');
    expect(chunks[2]?.choices[0]?.finish_reason).toBe('stop');
  });

  it('throws UpstreamError when a streaming response has no body', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const provider = createAnthropicProvider({ name: 'anthropic', baseUrl: 'http://h', fetchImpl });
    await expect(
      (async () => {
        for await (const _chunk of provider.chatStream(request)) {
          // drain
        }
      })(),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it('flattens array content, joins system blocks, and forwards top_p / stop', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: { headers: Record<string, string>; body: string }) =>
        Promise.resolve(jsonResponse(reply)),
    );
    const provider = createAnthropicProvider({ name: 'anthropic', baseUrl: 'http://h', fetchImpl });
    await provider.chat({
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: [{ type: 'text', text: 'multi' }, { type: 'image' }] },
        { role: 'assistant', content: 'ok' },
        { role: 'tool', content: 'treated-as-user' },
      ],
      top_p: 0.9,
      stop: ['STOP'],
    } as ChatCompletionRequest);

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body) as {
      system: string;
      top_p: number;
      stop_sequences: string[];
      messages: { role: string; content: string }[];
    };
    expect(body.system).toBe('A\n\nB'); // multiple system blocks joined
    expect(body.top_p).toBe(0.9);
    expect(body.stop_sequences).toEqual(['STOP']);
    expect(body.messages).toEqual([
      { role: 'user', content: 'multi' }, // text block extracted; image block dropped
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'treated-as-user' }, // non-system/assistant → user
    ]);
  });

  it('skips keep-alives, unknown events, and non-text deltas in the stream', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        streamResponse([
          ': ping\n\n', // comment, no data line
          'event: ping\ndata: {"type":"ping"}\n\n', // unknown type
          'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n', // not a delta
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta"}}\n\n', // non-text delta
          'event: content_block_delta\ndata: not-json\n\n', // unparseable
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
        ]),
      ),
    );
    const provider = createAnthropicProvider({ name: 'anthropic', baseUrl: 'http://h', fetchImpl });
    const out: string[] = [];
    for await (const payload of provider.chatStream(request)) out.push(payload);
    expect(out).toHaveLength(1);
    const chunk = JSON.parse(out[0]!) as { choices: { delta: { content?: string } }[] };
    expect(chunk.choices[0]?.delta.content).toBe('hi');
  });
});
