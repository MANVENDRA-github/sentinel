import { describe, it, expect } from 'vitest';
import { SENTINEL_VERSION, banner } from './index.js';

describe('gateway/banner', () => {
  it('embeds the current version', () => {
    expect(banner()).toBe(`sentinel-gateway v${SENTINEL_VERSION}`);
  });

  it('starts with the package name', () => {
    expect(banner()).toMatch(/^sentinel-gateway /);
  });
});
