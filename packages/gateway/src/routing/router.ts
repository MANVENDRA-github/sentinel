import type { ChatCompletionRequest } from '../schemas.js';
import type { Provider } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { ModelNotFoundError } from '../errors.js';
import { classifyTier } from './classifier.js';

/** One (provider, model) pair the executor may try, in priority order. */
export interface Candidate {
  provider: Provider;
  model: string;
}

/** Routing rules from the config file. Both lists are optional. */
export interface RoutingConfig {
  /** Cheapest-first model tiers for `model: "auto"`. */
  tiers?: string[] | undefined;
  /** Models appended as fallbacks to every request's candidate chain. */
  fallback?: string[] | undefined;
  /** Complexity score boundaries between tiers (defaults applied when omitted). */
  thresholds?: number[] | undefined;
}

export interface Router {
  /** Builds the ordered candidate chain for a request. Throws if nothing resolves. */
  resolveCandidates(request: ChatCompletionRequest): Candidate[];
}

export interface CreateRouterOptions {
  registry: ProviderRegistry;
  routing?: RoutingConfig;
}

/**
 * Turns a request into an ordered candidate chain. Explicit models become
 * `[model, ...fallback]`; `model: "auto"` is classified into the cheapest capable
 * tier and escalates through the remaining tiers, then the fallback chain.
 */
export function createRouter(options: CreateRouterOptions): Router {
  const registry = options.registry;
  const tiers = options.routing?.tiers ?? [];
  const fallback = options.routing?.fallback ?? [];

  return {
    resolveCandidates(request): Candidate[] {
      const requested = request.model;
      let names: string[];
      if (requested === 'auto') {
        if (tiers.length === 0) throw new ModelNotFoundError('auto');
        const index = classifyTier(request, tiers.length, options.routing?.thresholds);
        names = [...tiers.slice(index), ...fallback];
      } else {
        names = [requested, ...fallback];
      }

      const candidates: Candidate[] = [];
      const seen = new Set<string>();
      let primaryError: unknown;
      let isPrimary = true;
      for (const model of names) {
        let provider: Provider;
        try {
          provider = registry.resolve(model);
        } catch (error) {
          if (isPrimary) primaryError = error;
          isPrimary = false;
          if (error instanceof ModelNotFoundError) continue; // skip an unresolvable fallback
          throw error; // anything else is a real failure, not a routing miss
        }
        isPrimary = false;
        const key = `${provider.name}::${model}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({ provider, model });
        }
      }

      if (candidates.length === 0) {
        throw primaryError ?? new ModelNotFoundError(requested);
      }
      return candidates;
    },
  };
}
