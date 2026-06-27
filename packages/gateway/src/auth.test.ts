import { describe, it, expect } from 'vitest';
import { extractBearerToken } from './auth.js';

describe('extractBearerToken', () => {
  it('extracts a bearer token case-insensitively', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('bearer  xyz ')).toBe('xyz');
  });

  it('returns null for missing or malformed headers', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('Token abc')).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
  });
});
