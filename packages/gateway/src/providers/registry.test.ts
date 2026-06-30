import { describe, it, expect, vi } from 'vitest';
import { createRegistry } from './registry.js';
import { ModelNotFoundError } from '../errors.js';
import type { ResolvedConfig } from '../config.js';

const config: ResolvedConfig = {
  providers: new Map([
    [
      'ollama',
      {
        name: 'ollama',
        type: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        apiKeys: [],
      },
    ],
    [
      'openai',
      {
        name: 'openai',
        type: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKeys: ['k'],
      },
    ],
  ]),
  models: new Map([['qwen2.5:7b', 'ollama']]),
  defaultProvider: 'openai',
  pricing: new Map(),
};

describe('createRegistry', () => {
  it('resolves a known model to its provider', () => {
    const registry = createRegistry(config);
    expect(registry.resolve('qwen2.5:7b').name).toBe('ollama');
  });

  it('falls back to the default provider for unknown models', () => {
    const registry = createRegistry(config);
    expect(registry.resolve('something-else').name).toBe('openai');
  });

  it('throws when neither a model mapping nor a default matches', () => {
    const registry = createRegistry({ ...config, defaultProvider: undefined });
    expect(() => registry.resolve('nope')).toThrow(ModelNotFoundError);
  });

  it('throws when a model maps to a provider that was not built', () => {
    const broken: ResolvedConfig = {
      providers: new Map(),
      models: new Map([['m', 'ghost']]),
      defaultProvider: undefined,
      pricing: new Map(),
    };
    expect(() => createRegistry(broken).resolve('m')).toThrow(ModelNotFoundError);
  });

  it('passes a custom fetch through to the providers it builds', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    const registry = createRegistry(config, { fetchImpl });
    await registry
      .resolve('qwen2.5:7b')
      .chat({ model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('builds the Anthropic adapter for an anthropic-typed provider', async () => {
    const anthropicConfig: ResolvedConfig = {
      providers: new Map([
        [
          'claude',
          { name: 'claude', type: 'anthropic', baseUrl: 'http://h/v1', apiKeys: ['sk-ant'] },
        ],
      ]),
      models: new Map([['claude-3-5-sonnet', 'claude']]),
      defaultProvider: undefined,
      pricing: new Map(),
    };
    const fetchImpl = vi.fn(
      async (_url: string, _init: { headers: Record<string, string>; body: string }) =>
        Promise.resolve(
          new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }), {
            status: 200,
          }),
        ),
    );
    const registry = createRegistry(anthropicConfig, { fetchImpl });
    await registry
      .resolve('claude-3-5-sonnet')
      .chat({ model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }] });
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toContain('/messages');
    expect(call[1].headers['x-api-key']).toBe('sk-ant');
  });

  it('round-robins across a provider key pool on successive requests', async () => {
    const pooled: ResolvedConfig = {
      providers: new Map([
        [
          'groq',
          {
            name: 'groq',
            type: 'openai-compatible',
            baseUrl: 'http://h/v1',
            apiKeys: ['k1', 'k2'],
          },
        ],
      ]),
      models: new Map([['m', 'groq']]),
      defaultProvider: undefined,
      pricing: new Map(),
    };
    const seen: (string | undefined)[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers.authorization);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const registry = createRegistry(pooled, { fetchImpl });
    for (let i = 0; i < 3; i++) {
      await registry.resolve('m').chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    }
    expect(seen).toEqual(['Bearer k1', 'Bearer k2', 'Bearer k1']);
  });

  it('uses no auth header for a keyless provider pool', async () => {
    const keyless: ResolvedConfig = {
      providers: new Map([
        [
          'ollama',
          { name: 'ollama', type: 'openai-compatible', baseUrl: 'http://h/v1', apiKeys: [] },
        ],
      ]),
      models: new Map([['m', 'ollama']]),
      defaultProvider: undefined,
      pricing: new Map(),
    };
    const fetchImpl = vi.fn(async (_url: string, _init: { headers: Record<string, string> }) =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    const registry = createRegistry(keyless, { fetchImpl });
    await registry.resolve('m').chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(fetchImpl.mock.calls[0]![1].headers.authorization).toBeUndefined();
  });
});
