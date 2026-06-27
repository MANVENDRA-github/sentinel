import { describe, it, expect } from 'vitest';
import { chatCompletionRequestSchema } from './schemas.js';

describe('chatCompletionRequestSchema', () => {
  it('accepts a valid request and preserves unknown fields', () => {
    const result = chatCompletionRequestSchema.safeParse({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      custom_field: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('gpt-4o-mini');
      expect((result.data as Record<string, unknown>).custom_field).toBe(42);
    }
  });

  it('rejects a request with no model', () => {
    const result = chatCompletionRequestSchema.safeParse({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a request with no messages', () => {
    const result = chatCompletionRequestSchema.safeParse({ model: 'm', messages: [] });
    expect(result.success).toBe(false);
  });
});
