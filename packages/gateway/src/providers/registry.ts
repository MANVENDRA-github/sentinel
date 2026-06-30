import type { ResolvedConfig } from '../config.js';
import type { ApiKeySource, FetchLike, Provider } from './types.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';
import { createAnthropicProvider } from './anthropic.js';
import { ModelNotFoundError } from '../errors.js';

/** A key source for a provider: undefined (keyless), the single key, or a round-robin over the pool. */
function keySupplier(keys: readonly string[]): ApiKeySource | undefined {
  if (keys.length === 0) return undefined;
  if (keys.length === 1) return keys[0];
  let index = 0;
  return () => {
    const key = keys[index % keys.length];
    index += 1;
    return key;
  };
}

export interface ProviderRegistry {
  /** Resolves a model name to the provider that serves it. */
  resolve(model: string): Provider;
}

export interface CreateRegistryOptions {
  fetchImpl?: FetchLike;
}

/** Builds providers from resolved config and resolves models to them. */
export function createRegistry(
  config: ResolvedConfig,
  options: CreateRegistryOptions = {},
): ProviderRegistry {
  const providers = new Map<string, Provider>();
  for (const resolved of config.providers.values()) {
    const apiKey = keySupplier(resolved.apiKeys);
    const adapterOptions = {
      name: resolved.name,
      baseUrl: resolved.baseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    };
    providers.set(
      resolved.name,
      resolved.type === 'anthropic'
        ? createAnthropicProvider(adapterOptions)
        : createOpenAICompatibleProvider(adapterOptions),
    );
  }

  return {
    resolve(model: string): Provider {
      const providerName = config.models.get(model) ?? config.defaultProvider;
      if (providerName === undefined) {
        throw new ModelNotFoundError(model);
      }
      const provider = providers.get(providerName);
      if (provider === undefined) {
        throw new ModelNotFoundError(model);
      }
      return provider;
    },
  };
}
