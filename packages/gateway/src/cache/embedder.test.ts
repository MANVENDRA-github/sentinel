import { describe, it, expect, vi } from 'vitest';
import { createOllamaEmbedder } from './embedder.js';

describe('createOllamaEmbedder', () => {
  it('posts to /embeddings and returns the vector', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: { body: string }) =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }),
      ),
    );
    const embedder = createOllamaEmbedder({
      baseUrl: 'http://h/v1/',
      model: 'nomic-embed-text',
      fetchImpl,
    });

    const vec = await embedder.embed('hello');
    expect(vec).toEqual([0.1, 0.2, 0.3]);

    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe('http://h/v1/embeddings');
    expect(JSON.parse(call[1].body) as { model: string; input: string }).toEqual({
      model: 'nomic-embed-text',
      input: 'hello',
    });
  });

  it('throws on a non-OK response', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('nope', { status: 500 })));
    const embedder = createOllamaEmbedder({ baseUrl: 'http://h', model: 'm', fetchImpl });
    await expect(embedder.embed('x')).rejects.toThrow();
  });

  it('throws when the embedding is missing', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    const embedder = createOllamaEmbedder({ baseUrl: 'http://h', model: 'm', fetchImpl });
    await expect(embedder.embed('x')).rejects.toThrow();
  });
});
