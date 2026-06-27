import { describe, it, expect } from 'vitest';
import { createRouter } from './router.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Provider } from '../providers/types.js';
import { ModelNotFoundError } from '../errors.js';
import type { ChatCompletionRequest } from '../schemas.js';

function provider(name: string): Provider {
  return {
    name,
    chat: () => Promise.resolve({}),
    chatStream: async function* () {
      yield 'x';
    },
  };
}

function registryOf(map: Record<string, Provider>, fallbackProvider?: Provider): ProviderRegistry {
  return {
    resolve(model) {
      const p = map[model] ?? fallbackProvider;
      if (p === undefined) throw new ModelNotFoundError(model);
      return p;
    },
  };
}

const reqOf = (model: string, content = 'hi'): ChatCompletionRequest => ({
  model,
  messages: [{ role: 'user', content }],
});

describe('createRouter', () => {
  const a = provider('a');
  const b = provider('b');
  const local = provider('local');

  it('builds [model, ...fallback] for an explicit model', () => {
    const router = createRouter({ registry: registryOf({ a, b }), routing: { fallback: ['b'] } });
    const candidates = router.resolveCandidates(reqOf('a'));
    expect(candidates.map((c) => `${c.provider.name}:${c.model}`)).toEqual(['a:a', 'b:b']);
  });

  it('returns a single candidate with no fallback configured', () => {
    const router = createRouter({ registry: registryOf({ a }) });
    expect(router.resolveCandidates(reqOf('a'))).toHaveLength(1);
  });

  it('classifies model:"auto" into the cheapest tier and escalates through the rest', () => {
    const router = createRouter({
      registry: registryOf({ a, b, local }),
      routing: { tiers: ['a', 'b'], fallback: ['local'] },
    });
    const candidates = router.resolveCandidates(reqOf('auto'));
    expect(candidates.map((c) => c.model)).toEqual(['a', 'b', 'local']);
  });

  it('throws when model:"auto" has no tiers configured', () => {
    const router = createRouter({ registry: registryOf({ a }) });
    expect(() => router.resolveCandidates(reqOf('auto'))).toThrow(ModelNotFoundError);
  });

  it('skips a fallback that does not resolve', () => {
    const router = createRouter({ registry: registryOf({ a }), routing: { fallback: ['ghost'] } });
    const candidates = router.resolveCandidates(reqOf('a'));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.model).toBe('a');
  });

  it('dedupes candidates resolving to the same provider and model', () => {
    const router = createRouter({ registry: registryOf({ a }), routing: { fallback: ['a'] } });
    expect(router.resolveCandidates(reqOf('a'))).toHaveLength(1);
  });

  it('throws the primary error when nothing resolves', () => {
    const router = createRouter({ registry: registryOf({}), routing: { fallback: ['x'] } });
    expect(() => router.resolveCandidates(reqOf('missing'))).toThrow(ModelNotFoundError);
  });

  it('propagates a non-model-not-found registry error', () => {
    const registry: ProviderRegistry = {
      resolve() {
        throw new Error('boom');
      },
    };
    const router = createRouter({ registry });
    expect(() => router.resolveCandidates(reqOf('a'))).toThrow('boom');
  });
});
