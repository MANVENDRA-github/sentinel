import type { FetchLike } from '../providers/types.js';

/** Produces an embedding vector for a piece of text. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export interface OllamaEmbedderOptions {
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  /** Injectable fetch (defaults to global `fetch`); handy for tests. */
  fetchImpl?: FetchLike;
}

interface EmbeddingsResponse {
  data?: { embedding?: unknown }[];
}

/**
 * Embeds text via an OpenAI-compatible `/embeddings` endpoint — e.g. local Ollama
 * `nomic-embed-text` (keyless). Mirrors the provider adapter's fetch/header pattern.
 */
export function createOllamaEmbedder(options: OllamaEmbedderOptions): Embedder {
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/embeddings`;

  return {
    async embed(text: string): Promise<number[]> {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.apiKey !== undefined && options.apiKey.length > 0) {
        headers.authorization = `Bearer ${options.apiKey}`;
      }
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: options.model, input: text }),
      });
      if (!res.ok) {
        throw new Error(`embeddings request failed: HTTP ${res.status}`);
      }
      const json = (await res.json()) as EmbeddingsResponse;
      const embedding = json.data?.[0]?.embedding;
      if (!Array.isArray(embedding)) {
        throw new Error('embeddings response missing data[0].embedding');
      }
      return embedding.map((n) => (typeof n === 'number' ? n : 0));
    },
  };
}
