import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError } from './errors.js';

// ─────────────────────────── Server environment ───────────────────────────

export interface ServerEnv {
  port: number;
  apiKeys: ReadonlySet<string>;
  configPath: string;
}

const serverEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  SENTINEL_API_KEYS: z.string().default(''),
  SENTINEL_CONFIG: z.string().default('./sentinel.config.json'),
});

/** Reads and validates the process environment Sentinel needs to run. */
export function loadServerEnv(env: NodeJS.ProcessEnv): ServerEnv {
  const parsed = serverEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment: ${formatIssues(parsed.error)}`);
  }
  const apiKeys = parsed.data.SENTINEL_API_KEYS.split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  if (apiKeys.length === 0) {
    throw new ConfigError('SENTINEL_API_KEYS must list at least one comma-separated key.');
  }
  return {
    port: parsed.data.PORT,
    apiKeys: new Set(apiKeys),
    configPath: parsed.data.SENTINEL_CONFIG,
  };
}

// ─────────────────────────── Provider config file ──────────────────────────

const providerConfigSchema = z
  .object({
    type: z.literal('openai-compatible'),
    baseUrl: z.string().url().optional(),
    baseUrlEnv: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
  })
  .refine((p) => (p.baseUrl === undefined) !== (p.baseUrlEnv === undefined), {
    message: 'set exactly one of "baseUrl" or "baseUrlEnv"',
  });

const sentinelConfigSchema = z
  .object({
    providers: z.record(z.string(), providerConfigSchema),
    models: z.record(z.string(), z.string()),
    defaultProvider: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    const names = new Set(Object.keys(cfg.providers));
    for (const [model, provider] of Object.entries(cfg.models)) {
      if (!names.has(provider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `model "${model}" points at unknown provider "${provider}"`,
        });
      }
    }
    if (cfg.defaultProvider !== undefined && !names.has(cfg.defaultProvider)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `defaultProvider "${cfg.defaultProvider}" is not a declared provider`,
      });
    }
  });

export interface ResolvedProvider {
  name: string;
  baseUrl: string;
  apiKey: string | undefined;
}

export interface ResolvedConfig {
  providers: Map<string, ResolvedProvider>;
  /** model name → provider name */
  models: Map<string, string>;
  defaultProvider: string | undefined;
}

export interface LoadConfigOptions {
  path: string;
  env: NodeJS.ProcessEnv;
  /** Injectable file reader (defaults to `fs.readFileSync`); handy for tests. */
  readFile?: (path: string) => string;
}

/** Reads, validates, and resolves the provider config file into runtime form. */
export function loadConfig(options: LoadConfigOptions): ResolvedConfig {
  const read = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  let raw: string;
  try {
    raw = read(options.path);
  } catch (err) {
    throw new ConfigError(`Could not read config file "${options.path}": ${errMessage(err)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Config file "${options.path}" is not valid JSON: ${errMessage(err)}`);
  }

  const parsed = sentinelConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`Invalid config "${options.path}": ${formatIssues(parsed.error)}`);
  }

  const providers = new Map<string, ResolvedProvider>();
  for (const [name, p] of Object.entries(parsed.data.providers)) {
    const baseUrl = p.baseUrl ?? readEnvOrThrow(options.env, p.baseUrlEnv, name);
    const apiKey = p.apiKeyEnv === undefined ? undefined : options.env[p.apiKeyEnv];
    providers.set(name, { name, baseUrl, apiKey });
  }

  return {
    providers,
    models: new Map(Object.entries(parsed.data.models)),
    defaultProvider: parsed.data.defaultProvider,
  };
}

function readEnvOrThrow(env: NodeJS.ProcessEnv, key: string | undefined, provider: string): string {
  if (key === undefined) {
    throw new ConfigError(`provider "${provider}" is missing a base URL`);
  }
  const value = env[key];
  if (value === undefined || value.length === 0) {
    throw new ConfigError(`provider "${provider}" needs env var ${key} to be set`);
  }
  return value;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
