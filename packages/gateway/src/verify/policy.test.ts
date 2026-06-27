import { describe, it, expect } from 'vitest';
import { detectPolicy } from './policy.js';

describe('detectPolicy', () => {
  it('returns nothing for clean text', () => {
    expect(detectPolicy('the weather is pleasant today')).toEqual([]);
  });

  it('flags an email address', () => {
    expect(detectPolicy('reach me at alice@example.com please')).toContain('pii.email');
  });

  it('flags an SSN', () => {
    expect(detectPolicy('my ssn is 123-45-6789')).toContain('pii.ssn');
  });

  it('flags a phone number', () => {
    expect(detectPolicy('call (415) 555-0132 today')).toContain('pii.phone');
  });

  it('flags an API-key-like token', () => {
    expect(detectPolicy('token sk-ABCDEFGHIJKLMNOPQRST')).toContain('pii.api_key');
  });

  it('flags a valid IPv4 but not impossible octets', () => {
    expect(detectPolicy('host at 192.168.1.10')).toContain('pii.ipv4');
    expect(detectPolicy('build 999.999.999.999 failed')).not.toContain('pii.ipv4');
  });

  it('flags a Luhn-valid card and ignores a non-Luhn run', () => {
    expect(detectPolicy('card 4242 4242 4242 4242 ok')).toContain('pii.credit_card');
    expect(detectPolicy('id 4242 4242 4242 4241 here')).not.toContain('pii.credit_card');
  });

  it('flags a blocklist term (case-insensitive)', () => {
    expect(detectPolicy('this is Forbidden content', { blocklist: ['forbidden'] })).toContain(
      'policy.blocklist',
    );
  });

  it('flags a refusal', () => {
    expect(detectPolicy("I'm sorry, I cannot help with that")).toContain('policy.refusal');
  });

  it('honors the pii allowlist (only checks listed categories)', () => {
    const found = detectPolicy('alice@example.com', { pii: ['pii.ssn'] });
    expect(found).not.toContain('pii.email');
  });
});
