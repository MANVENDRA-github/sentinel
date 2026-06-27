import { describe, it, expect } from 'vitest';
import { runGuardrails } from './guardrails.js';
import { chatCompletionRequestSchema } from '../schemas.js';
import type { ChatCompletionRequest } from '../schemas.js';

const plain: ChatCompletionRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

const withFormat = (responseFormat: unknown): ChatCompletionRequest =>
  chatCompletionRequestSchema.parse({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    response_format: responseFormat,
  });

describe('runGuardrails', () => {
  it('passes a clean response', () => {
    expect(runGuardrails(plain, 'all good', { block: false })).toEqual({
      status: 'pass',
      violations: [],
    });
  });

  it('flags a PII violation by default', () => {
    const verdict = runGuardrails(plain, 'mail me at a@b.com', { block: false });
    expect(verdict.status).toBe('flag');
    expect(verdict.violations).toContain('pii.email');
  });

  it('blocks a violation when blocking is enabled', () => {
    expect(runGuardrails(plain, 'a@b.com', { block: true }).status).toBe('block');
  });

  it('flags invalid JSON when JSON was requested', () => {
    const request = withFormat({ type: 'json_object' });
    expect(runGuardrails(request, 'not json', { block: false }).violations).toContain(
      'format.invalid_json',
    );
  });

  it('flags a schema mismatch and passes a matching object', () => {
    const request = withFormat({
      type: 'json_schema',
      json_schema: { schema: { type: 'object', required: ['x'] } },
    });
    expect(runGuardrails(request, '{"y":1}', { block: false }).violations).toContain(
      'format.schema_mismatch',
    );
    expect(runGuardrails(request, '{"x":1}', { block: false }).status).toBe('pass');
  });

  it('fails closed (block) when a check throws', () => {
    const request = withFormat({ type: 'json_schema', json_schema: { schema: 42 } });
    const verdict = runGuardrails(request, '{"x":1}', { block: false });
    expect(verdict.status).toBe('block');
    expect(verdict.violations).toContain('guardrail.error');
  });

  it('skips JSON checks when requireJson is false', () => {
    const request = withFormat({ type: 'json_object' });
    expect(runGuardrails(request, 'not json', { block: false, requireJson: false }).status).toBe(
      'pass',
    );
  });
});
