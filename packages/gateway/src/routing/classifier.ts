import type { ChatCompletionRequest } from '../schemas.js';

/** Default score boundaries between tiers; crossing one escalates to the next tier. */
export const DEFAULT_THRESHOLDS = [400, 2000, 8000, 32_000];

/** A cheap, model-free complexity estimate from the request shape. */
function complexityScore(request: ChatCompletionRequest): number {
  let chars = 0;
  for (const message of request.messages) {
    const content = message.content;
    if (typeof content === 'string') chars += content.length;
    else if (content !== undefined && content !== null) chars += JSON.stringify(content).length;
  }
  const maxTokens = typeof request.max_tokens === 'number' ? request.max_tokens : 0;
  return chars + maxTokens * 4 + request.messages.length * 100;
}

/**
 * Picks a tier index (0 = cheapest) for `model: "auto"`, given how many tiers are
 * configured. Deterministic and rules-based: longer prompts, more messages, and a
 * larger `max_tokens` budget escalate to higher (more capable) tiers.
 */
export function classifyTier(
  request: ChatCompletionRequest,
  tierCount: number,
  thresholds: readonly number[] = DEFAULT_THRESHOLDS,
): number {
  if (tierCount <= 1) return 0;
  const score = complexityScore(request);
  let index = 0;
  for (const threshold of thresholds) {
    if (score >= threshold) index += 1;
    else break;
  }
  return Math.min(index, tierCount - 1);
}
