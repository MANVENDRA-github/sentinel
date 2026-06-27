import type { ChatCompletionRequest } from '../schemas.js';
import type { FetchLike, Provider } from './types.js';
import { UpstreamError } from '../errors.js';

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey?: string | undefined;
  /** Injectable fetch (defaults to global `fetch`); handy for tests. */
  fetchImpl?: FetchLike;
}

/**
 * Creates a provider for any OpenAI-compatible HTTP API — OpenAI, Groq, Mistral,
 * OpenRouter, DeepSeek, xAI, Gemini's OpenAI endpoint, local Ollama, and others.
 */
export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): Provider {
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.apiKey !== undefined && options.apiKey.length > 0) {
      headers.authorization = `Bearer ${options.apiKey}`;
    }
    return headers;
  }

  async function send(
    request: ChatCompletionRequest,
    stream: boolean,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ ...request, stream }),
      // Don't follow upstream redirects — a malicious provider could 3xx the prompt to another host.
      redirect: 'error',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw await UpstreamError.fromResponse(options.name, res);
    }
    return res;
  }

  return {
    name: options.name,
    async chat(request, signal) {
      const res = await send(request, false, signal);
      return (await res.json()) as unknown;
    },
    async *chatStream(request, signal) {
      const res = await send(request, true, signal);
      if (res.body === null) {
        throw new UpstreamError(options.name, 502, 'upstream returned no response body');
      }
      yield* parseSSE(res.body);
    },
  };
}

/** Parses an OpenAI-style SSE stream, yielding each `data:` payload until `[DONE]`. */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const event = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const payload = extractData(event);
        if (payload === '[DONE]') return;
        if (payload !== null) yield payload;
        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function extractData(event: string): string | null {
  const dataLines = event
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart());
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}
