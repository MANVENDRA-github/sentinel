import { z } from 'zod';
import type { ChatCompletionRequest } from '../schemas.js';
import type { ApiKeySource, FetchLike, Provider } from './types.js';
import { UpstreamError } from '../errors.js';

/**
 * Native adapter for Anthropic's Messages API (`POST /v1/messages`), which is
 * NOT OpenAI-compatible: different auth header (`x-api-key`), a top-level
 * `system` field, a required `max_tokens`, and a distinct response/stream shape.
 * This adapter translates an OpenAI chat request in and an OpenAI response out,
 * so the rest of the gateway only ever sees the OpenAI shape.
 */

const ANTHROPIC_VERSION = '2023-06-01';
// Anthropic requires max_tokens; OpenAI's is optional. Used when the caller omits it.
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicOptions {
  name: string;
  baseUrl: string;
  /** A fixed key, or a supplier that returns the next key (round-robin across a pool). */
  apiKey?: ApiKeySource | undefined;
  /** Injectable fetch (defaults to global `fetch`); handy for tests. */
  fetchImpl?: FetchLike;
}

/** The slice of an Anthropic Messages response we translate to the OpenAI shape. */
const anthropicResponseSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    content: z
      .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
      .optional(),
    stop_reason: z.string().nullable().optional(),
    usage: z
      .object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() })
      .optional(),
  })
  .passthrough();

type AnthropicResponse = z.infer<typeof anthropicResponseSchema>;

/** Creates a provider backed by Anthropic's native Messages API. */
export function createAnthropicProvider(options: AnthropicOptions): Provider {
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/messages`;

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    };
    const key = typeof options.apiKey === 'function' ? options.apiKey() : options.apiKey;
    if (key !== undefined && key.length > 0) {
      headers['x-api-key'] = key;
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
      body: JSON.stringify(toAnthropicBody(request, stream)),
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
      const parsed = anthropicResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new UpstreamError(options.name, 502, 'unexpected Anthropic response shape');
      }
      return toOpenAIResponse(parsed.data, request.model);
    },
    async *chatStream(request, signal) {
      const res = await send(request, true, signal);
      if (res.body === null) {
        throw new UpstreamError(options.name, 502, 'upstream returned no response body');
      }
      yield* translateStream(res.body, request.model);
    },
  };
}

/** Flattens OpenAI message content (string or text-block array) to plain text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
}

/** Translates an OpenAI chat request into an Anthropic Messages request body. */
function toAnthropicBody(request: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const message of request.messages) {
    const text = contentToText(message.content);
    if (message.role === 'system') {
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    // Anthropic only accepts user/assistant turns; map anything else to user.
    messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: text });
  }

  const extra = request as Record<string, unknown>;
  const topP = typeof extra.top_p === 'number' ? extra.top_p : undefined;
  const stop = extra.stop;
  const stopSequences =
    typeof stop === 'string'
      ? [stop]
      : Array.isArray(stop)
        ? stop.filter((s): s is string => typeof s === 'string')
        : undefined;

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  if (systemParts.length > 0) body.system = systemParts.join('\n\n');
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (topP !== undefined) body.top_p = topP;
  if (stopSequences !== undefined && stopSequences.length > 0) body.stop_sequences = stopSequences;
  if (stream) body.stream = true;
  return body;
}

/** Builds an OpenAI chat-completion response from an Anthropic Messages response. */
function toOpenAIResponse(a: AnthropicResponse, requestModel: string): Record<string, unknown> {
  const text = (a.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');

  const response: Record<string, unknown> = {
    id: a.id ?? 'anthropic',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: a.model ?? requestModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: mapStopReason(a.stop_reason ?? null),
      },
    ],
  };
  if (a.usage !== undefined) {
    const prompt = a.usage.input_tokens ?? 0;
    const completion = a.usage.output_tokens ?? 0;
    response.usage = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    };
  }
  return response;
}

/** Maps an Anthropic `stop_reason` to the OpenAI `finish_reason` vocabulary. */
function mapStopReason(reason: string | null): string | null {
  switch (reason) {
    case null:
      return null;
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'end_turn':
    case 'stop_sequence':
    default:
      return 'stop';
  }
}

/** Translates an Anthropic SSE stream into OpenAI `chat.completion.chunk` payload strings. */
async function* translateStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const id = 'anthropic';
  const created = Math.floor(Date.now() / 1000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const chunk = translateEvent(buffer.slice(0, separator), id, created, model);
        buffer = buffer.slice(separator + 2);
        if (chunk !== null) yield chunk;
        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Translates one Anthropic SSE event into an OpenAI chunk string, or null to skip it. */
function translateEvent(event: string, id: string, created: number, model: string): string | null {
  const dataLine = event.split('\n').find((line) => line.startsWith('data:'));
  if (dataLine === undefined) return null;
  const payload = dataLine.slice('data:'.length).trim();
  if (payload.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null; // a keep-alive or non-JSON line — nothing to forward
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { type?: unknown; delta?: unknown };

  if (obj.type === 'content_block_delta') {
    const delta = obj.delta as { type?: unknown; text?: unknown } | undefined;
    if (delta !== undefined && delta.type === 'text_delta' && typeof delta.text === 'string') {
      return openAIChunk(id, created, model, { content: delta.text }, null);
    }
    return null;
  }
  if (obj.type === 'message_delta') {
    const delta = obj.delta as { stop_reason?: unknown } | undefined;
    const stop =
      delta !== undefined && typeof delta.stop_reason === 'string' ? delta.stop_reason : null;
    return openAIChunk(id, created, model, {}, mapStopReason(stop));
  }
  return null;
}

function openAIChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): string {
  return JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}
