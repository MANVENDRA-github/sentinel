import { describe, it, expect } from 'vitest';
import { computeCostUsd } from './cost.js';
import type { ModelPricing } from './cost.js';

const pricing = new Map<string, ModelPricing>([
  ['gpt-4o-mini', { inputPer1k: 0.15, outputPer1k: 0.6 }],
  ['free-local', { inputPer1k: 0, outputPer1k: 0 }],
  ['dusty', { inputPer1k: 0.1, outputPer1k: 0.2 }],
]);

describe('computeCostUsd', () => {
  it('prices input and output tokens from the per-1K rates', () => {
    // 1000 prompt × 0.15/1K + 500 completion × 0.6/1K = 0.15 + 0.30 = 0.45
    expect(
      computeCostUsd('gpt-4o-mini', { promptTokens: 1000, completionTokens: 500 }, pricing),
    ).toBe(0.45);
  });

  it('returns null for a model that is not in the price map', () => {
    expect(
      computeCostUsd('mystery-model', { promptTokens: 100, completionTokens: 100 }, pricing),
    ).toBeNull();
  });

  it('returns null when no usage is available (both sides null)', () => {
    expect(
      computeCostUsd('gpt-4o-mini', { promptTokens: null, completionTokens: null }, pricing),
    ).toBeNull();
  });

  it('treats a missing side as zero when the other side is known', () => {
    expect(
      computeCostUsd('gpt-4o-mini', { promptTokens: 2000, completionTokens: null }, pricing),
    ).toBe(0.3);
    expect(
      computeCostUsd('gpt-4o-mini', { promptTokens: null, completionTokens: 1000 }, pricing),
    ).toBe(0.6);
  });

  it('returns 0 (not null) for a priced-but-free model with real usage', () => {
    expect(
      computeCostUsd('free-local', { promptTokens: 500, completionTokens: 500 }, pricing),
    ).toBe(0);
  });

  it('rounds away binary float dust (0.1 + 0.2)', () => {
    // 1000/1K × 0.1 + 1000/1K × 0.2 = 0.30000000000000004 in IEEE-754 → rounded to 0.3
    expect(computeCostUsd('dusty', { promptTokens: 1000, completionTokens: 1000 }, pricing)).toBe(
      0.3,
    );
  });
});
