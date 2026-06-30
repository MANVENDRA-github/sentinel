import { describe, it, expect } from 'vitest';
import { classifyTier } from './classifier.js';
import type { ChatCompletionRequest } from '../schemas.js';

function reqOf(content: string, extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return { model: 'auto', messages: [{ role: 'user', content }], ...extra };
}

describe('classifyTier', () => {
  it('returns 0 when there is a single tier', () => {
    expect(classifyTier(reqOf('x'.repeat(50_000)), 1)).toBe(0);
  });

  it('routes a short prompt to the cheapest tier', () => {
    expect(classifyTier(reqOf('hi'), 3)).toBe(0);
  });

  it('escalates a long prompt to a higher tier', () => {
    expect(classifyTier(reqOf('x'.repeat(3000)), 3)).toBe(2);
  });

  it('clamps the index to the available tiers', () => {
    expect(classifyTier(reqOf('x'.repeat(50_000)), 2)).toBe(1);
  });

  it('factors in max_tokens', () => {
    expect(classifyTier(reqOf('short', { max_tokens: 2000 }), 4)).toBe(3); // 5 + 8000 + 100
  });

  it('handles non-string (array) content', () => {
    const request: ChatCompletionRequest = {
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    expect(classifyTier(request, 3)).toBe(0);
  });

  it('honours custom thresholds over the defaults', () => {
    // 'hello world' (11 chars) + 1 message × 100 = score 111.
    expect(classifyTier(reqOf('hello world'), 3, [10, 20])).toBe(2); // low bars → top tier
    expect(classifyTier(reqOf('hello world'), 3, [100_000])).toBe(0); // high bar → cheapest
  });
});
