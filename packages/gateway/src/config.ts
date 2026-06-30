import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError } from './errors.js';
import type { ModelPricing } from './cost.js';

// ─────────────────────────── Server environment ───────────────────────────

export interface ServerEnv {
  port: number;
  apiKeys: ReadonlySet<string>;
  configPath: string;
  adminKey: string | undefined;
  traceDb: 'sqlite' | 'memory';
  traceDbPath: string;
  cacheEnabled: boolean;
  cacheThreshold: number;
  cacheTtlSeconds: number;
  cacheMaxEntries: number;
  ollamaBaseUrl: string;
  embedModel: string;
  requestTimeoutMs: number;
  maxRetries: number;
  defaultRpm: number;
  throttleMaxWaitMs: number;
  verifyEnabled: boolean;
  guardrailsBlock: boolean;
  judgeEnabled: boolean;
  judgeModel: string;
  judgeSampleRate: number;
  clientRpm: number;
}

const serverEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  SENTINEL_API_KEYS: z.string().default(''),
  SENTINEL_CONFIG: z.string().default('./sentinel.config.json'),
  SENTINEL_ADMIN_KEY: z.string().optional(),
  TRACE_DB: z.enum(['sqlite', 'memory']).default('sqlite'),
  TRACE_DB_PATH: z.string().default('./traces.db'),
  CACHE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  CACHE_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(1000),
  OLLAMA_BASE_URL: z.string().default('http://localhost:11434/v1'),
  EMBED_MODEL: z.string().default('nomic-embed-text'),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
  MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  DEFAULT_RPM: z.coerce.number().int().nonnegative().default(0),
  THROTTLE_MAX_WAIT_MS: z.coerce.number().int().nonnegative().default(2_000),
  VERIFY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  GUARDRAILS_BLOCK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  JUDGE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  JUDGE_MODEL: z.string().default('qwen2.5:7b'),
  JUDGE_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  CLIENT_RPM: z.coerce.number().int().nonnegative().default(0),
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
    adminKey: parsed.data.SENTINEL_ADMIN_KEY,
    traceDb: parsed.data.TRACE_DB,
    traceDbPath: parsed.data.TRACE_DB_PATH,
    cacheEnabled: parsed.data.CACHE_ENABLED,
    cacheThreshold: parsed.data.CACHE_SIMILARITY_THRESHOLD,
    cacheTtlSeconds: parsed.data.CACHE_TTL_SECONDS,
    cacheMaxEntries: parsed.data.CACHE_MAX_ENTRIES,
    ollamaBaseUrl: parsed.data.OLLAMA_BASE_URL,
    embedModel: parsed.data.EMBED_MODEL,
    requestTimeoutMs: parsed.data.REQUEST_TIMEOUT_MS,
    maxRetries: parsed.data.MAX_RETRIES,
    defaultRpm: parsed.data.DEFAULT_RPM,
    throttleMaxWaitMs: parsed.data.THROTTLE_MAX_WAIT_MS,
    verifyEnabled: parsed.data.VERIFY_ENABLED,
    guardrailsBlock: parsed.data.GUARDRAILS_BLOCK,
    judgeEnabled: parsed.data.JUDGE_ENABLED,
    judgeModel: parsed.data.JUDGE_MODEL,
    judgeSampleRate: parsed.data.JUDGE_SAMPLE_RATE,
    clientRpm: parsed.data.CLIENT_RPM,
  };
}

// ─────────────────────────── Provider config file ──────────────────────────

const providerConfigSchema = z
  .object({
    type: z.enum(['openai-compatible', 'anthropic']),
    baseUrl: z.string().url().optional(),
    baseUrlEnv: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    /** Multiple key env vars to round-robin across (combined with `apiKeyEnv` if both are set). */
    apiKeyEnvs: z.array(z.string().min(1)).optional(),
    rpm: z.coerce.number().int().nonnegative().optional(),
  })
  .refine((p) => (p.baseUrl === undefined) !== (p.baseUrlEnv === undefined), {
    message: 'set exactly one of "baseUrl" or "baseUrlEnv"',
  });

const routingConfigSchema = z.object({
  tiers: z.array(z.string().min(1)).optional(),
  fallback: z.array(z.string().min(1)).optional(),
});

const guardrailsConfigSchema = z.object({
  blocklist: z.array(z.string().min(1)).optional(),
  pii: z.array(z.string().min(1)).optional(),
  requireJson: z.boolean().optional(),
});

// USD per 1,000 tokens, per model. Used to attribute a cost to every traced request.
const modelPricingSchema = z.object({
  inputPer1k: z.number().nonnegative(),
  outputPer1k: z.number().nonnegative(),
});

const sentinelConfigSchema = z
  .object({
    providers: z.record(z.string(), providerConfigSchema),
    models: z.record(z.string(), z.string()),
    defaultProvider: z.string().optional(),
    routing: routingConfigSchema.optional(),
    guardrails: guardrailsConfigSchema.optional(),
    pricing: z.record(z.string(), modelPricingSchema).optional(),
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
  /** Which adapter serves this provider: a generic OpenAI-compatible HTTP API or Anthropic's Messages API. */
  type: 'openai-compatible' | 'anthropic';
  baseUrl: string;
  /** Resolved API keys for this provider (0 = keyless, >1 = round-robin pool). */
  apiKeys: string[];
  /** Per-provider requests-per-minute limit for the throttle (omitted = unlimited). */
  rpm?: number;
}

/** Routing rules (tier list + fallback chain) from the config file. */
export interface ResolvedRouting {
  tiers?: string[] | undefined;
  fallback?: string[] | undefined;
}

/** Guardrail policy (content blocklist + PII categories) from the config file. */
export interface ResolvedGuardrails {
  blocklist?: string[] | undefined;
  pii?: string[] | undefined;
  requireJson?: boolean | undefined;
}

export interface ResolvedConfig {
  providers: Map<string, ResolvedProvider>;
  /** model name → provider name */
  models: Map<string, string>;
  defaultProvider: string | undefined;
  routing?: ResolvedRouting;
  guardrails?: ResolvedGuardrails;
  /** model name → USD-per-1K-token pricing (empty when no `pricing` block is configured). */
  pricing: Map<string, ModelPricing>;
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
    const apiKeys = resolveApiKeys(options.env, p.apiKeyEnv, p.apiKeyEnvs);
    providers.set(name, {
      name,
      type: p.type,
      baseUrl,
      apiKeys,
      ...(p.rpm !== undefined ? { rpm: p.rpm } : {}),
    });
  }

  return {
    providers,
    models: new Map(Object.entries(parsed.data.models)),
    defaultProvider: parsed.data.defaultProvider,
    ...(parsed.data.routing ? { routing: parsed.data.routing } : {}),
    ...(parsed.data.guardrails ? { guardrails: parsed.data.guardrails } : {}),
    pricing: new Map(Object.entries(parsed.data.pricing ?? {})),
  };
}

/** Resolves a provider's key pool from `apiKeyEnv` (single) + `apiKeyEnvs` (many); skips unset/empty. */
function resolveApiKeys(
  env: NodeJS.ProcessEnv,
  single: string | undefined,
  multiple: string[] | undefined,
): string[] {
  const names = [...(single !== undefined ? [single] : []), ...(multiple ?? [])];
  const keys: string[] = [];
  for (const varName of names) {
    const value = env[varName];
    if (value !== undefined && value.length > 0) keys.push(value);
  }
  return keys;
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
