import type { ChatCompletionRequest } from '../schemas.js';

/** A minimal `fetch` shape, narrowed so tests can supply a mock without casts. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
    redirect?: 'follow' | 'error' | 'manual';
  },
) => Promise<Response>;

/** A provider Sentinel can forward chat-completion requests to. */
export interface Provider {
  readonly name: string;
  /** Non-streaming completion. Resolves to the provider's JSON response. */
  chat(request: ChatCompletionRequest, signal?: AbortSignal): Promise<unknown>;
  /** Streaming completion. Yields SSE `data:` payload strings (JSON chunks), excluding `[DONE]`. */
  chatStream(request: ChatCompletionRequest, signal?: AbortSignal): AsyncIterable<string>;
}
