import { describe, it, expect } from 'vitest';
import { validateAgainstSchema } from './schema.js';

describe('validateAgainstSchema', () => {
  it('accepts a value matching type, required, and properties', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
    };
    expect(validateAgainstSchema({ name: 'a', age: 3 }, schema)).toBe(true);
  });

  it('rejects a missing required key', () => {
    expect(validateAgainstSchema({ age: 3 }, { type: 'object', required: ['name'] })).toBe(false);
  });

  it('rejects a property type mismatch', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    expect(validateAgainstSchema({ name: 5 }, schema)).toBe(false);
  });

  it('rejects a top-level type mismatch', () => {
    expect(validateAgainstSchema('hi', { type: 'object' })).toBe(false);
    expect(validateAgainstSchema(5, { type: 'string' })).toBe(false);
  });

  it('validates array items', () => {
    expect(validateAgainstSchema([1, 2], { type: 'array', items: { type: 'number' } })).toBe(true);
    expect(validateAgainstSchema([1, 'x'], { type: 'array', items: { type: 'number' } })).toBe(
      false,
    );
  });

  it('handles integer, boolean, and null types', () => {
    expect(validateAgainstSchema(true, { type: 'boolean' })).toBe(true);
    expect(validateAgainstSchema(null, { type: 'null' })).toBe(true);
    expect(validateAgainstSchema(1.5, { type: 'integer' })).toBe(false);
  });

  it('throws on a non-object schema', () => {
    expect(() => validateAgainstSchema({}, 42)).toThrow();
  });

  it('throws on an unsupported type', () => {
    expect(() => validateAgainstSchema('x', { type: 'weird' })).toThrow();
  });
});
