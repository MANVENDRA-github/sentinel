/**
 * Per-request cost accounting. Pure functions over token usage and a per-model
 * price map — no I/O. The price map comes from `sentinel.config.json` (`pricing`).
 */

/** USD price for one model, per 1,000 tokens. */
export interface ModelPricing {
  /** USD per 1K prompt (input) tokens. */
  inputPer1k: number;
  /** USD per 1K completion (output) tokens. */
  outputPer1k: number;
}

/** Token counts from a (real or cached) completion; either side may be unknown. */
export interface TokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

/**
 * Computes the USD cost of a completion from its token usage and a price map.
 * Returns `null` — never a guess — when the model is not priced or no usage is
 * available, so an unpriced request is recorded as "unknown cost", not as `0`.
 */
export function computeCostUsd(
  model: string,
  usage: TokenUsage,
  pricing: ReadonlyMap<string, ModelPricing>,
): number | null {
  const price = pricing.get(model);
  if (price === undefined) return null;
  if (usage.promptTokens === null && usage.completionTokens === null) return null;
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const cost = (prompt / 1000) * price.inputPer1k + (completion / 1000) * price.outputPer1k;
  // Round to micro-dollars; avoids float dust like 0.000_000_000_2 in traces.
  return Math.round(cost * 1e6) / 1e6;
}
