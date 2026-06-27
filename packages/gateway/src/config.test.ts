import { describe, it, expect } from 'vitest';
import { loadServerEnv, loadConfig } from './config.js';
import { ConfigError } from './errors.js';

describe('loadServerEnv', () => {
  it('parses keys and defaults the port and config path', () => {
    const env = loadServerEnv({ SENTINEL_API_KEYS: 'a, b , c' });
    expect(env.port).toBe(8080);
    expect([...env.apiKeys]).toEqual(['a', 'b', 'c']);
    expect(env.configPath).toBe('./sentinel.config.json');
  });

  it('honours PORT and SENTINEL_CONFIG', () => {
    const env = loadServerEnv({
      SENTINEL_API_KEYS: 'k',
      PORT: '9000',
      SENTINEL_CONFIG: '/etc/s.json',
    });
    expect(env.port).toBe(9000);
    expect(env.configPath).toBe('/etc/s.json');
  });

  it('throws when no API keys are configured', () => {
    expect(() => loadServerEnv({})).toThrow(ConfigError);
    expect(() => loadServerEnv({ SENTINEL_API_KEYS: '  ' })).toThrow(ConfigError);
  });

  it('throws when PORT is not a positive integer', () => {
    expect(() => loadServerEnv({ SENTINEL_API_KEYS: 'k', PORT: 'abc' })).toThrow(ConfigError);
  });

  it('reads admin key and trace DB settings', () => {
    const env = loadServerEnv({
      SENTINEL_API_KEYS: 'k',
      SENTINEL_ADMIN_KEY: 'admin',
      TRACE_DB: 'memory',
      TRACE_DB_PATH: '/tmp/t.db',
    });
    expect(env.adminKey).toBe('admin');
    expect(env.traceDb).toBe('memory');
    expect(env.traceDbPath).toBe('/tmp/t.db');
  });

  it('defaults trace DB to sqlite and admin key to undefined', () => {
    const env = loadServerEnv({ SENTINEL_API_KEYS: 'k' });
    expect(env.traceDb).toBe('sqlite');
    expect(env.adminKey).toBeUndefined();
  });
});

const validConfig = JSON.stringify({
  providers: {
    ollama: { type: 'openai-compatible', baseUrlEnv: 'OLLAMA_BASE_URL' },
    openai: {
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
    },
  },
  models: { 'qwen2.5:7b': 'ollama', 'gpt-4o-mini': 'openai' },
  defaultProvider: 'ollama',
});

describe('loadConfig', () => {
  const env = { OLLAMA_BASE_URL: 'http://localhost:11434/v1', OPENAI_API_KEY: 'sk-test' };

  it('resolves providers, base URLs, and keys', () => {
    const cfg = loadConfig({ path: 'x', env, readFile: () => validConfig });
    expect(cfg.providers.get('ollama')?.baseUrl).toBe('http://localhost:11434/v1');
    expect(cfg.providers.get('ollama')?.apiKey).toBeUndefined();
    expect(cfg.providers.get('openai')?.apiKey).toBe('sk-test');
    expect(cfg.models.get('gpt-4o-mini')).toBe('openai');
    expect(cfg.defaultProvider).toBe('ollama');
  });

  it('throws on invalid JSON', () => {
    expect(() => loadConfig({ path: 'x', env, readFile: () => '{ not json' })).toThrow(ConfigError);
  });

  it('throws when a model points at an unknown provider', () => {
    const bad = JSON.stringify({ providers: {}, models: { m: 'ghost' } });
    expect(() => loadConfig({ path: 'x', env, readFile: () => bad })).toThrow(/unknown provider/);
  });

  it('throws when a referenced base-URL env var is not set', () => {
    expect(() => loadConfig({ path: 'x', env: {}, readFile: () => validConfig })).toThrow(
      ConfigError,
    );
  });

  it('throws when a provider sets neither baseUrl nor baseUrlEnv', () => {
    const bad = JSON.stringify({ providers: { p: { type: 'openai-compatible' } }, models: {} });
    expect(() => loadConfig({ path: 'x', env, readFile: () => bad })).toThrow(ConfigError);
  });

  it('throws when the config file cannot be read', () => {
    const readFile = () => {
      throw new Error('ENOENT');
    };
    expect(() => loadConfig({ path: 'missing.json', env, readFile })).toThrow(/Could not read/);
  });

  it('throws when a referenced base-URL env var is empty', () => {
    expect(() =>
      loadConfig({ path: 'x', env: { OLLAMA_BASE_URL: '' }, readFile: () => validConfig }),
    ).toThrow(ConfigError);
  });
});
