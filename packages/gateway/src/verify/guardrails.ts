import type { ChatCompletionRequest } from '../schemas.js';
import { detectPolicy } from './policy.js';
import { validateAgainstSchema } from './schema.js';

export type GuardrailStatus = 'pass' | 'flag' | 'block';

export interface GuardrailVerdict {
  status: GuardrailStatus;
  /** Matched category codes (e.g. `pii.email`, `format.invalid_json`) — never raw content. */
  violations: string[];
}

export interface GuardrailConfig {
  /** When true, a violation escalates to `block`; otherwise it is a `flag`. */
  block: boolean;
  /** Content-policy blocklist terms. */
  blocklist?: string[] | undefined;
  /** PII categories to check; omit ⇒ all. */
  pii?: string[] | undefined;
  /** Validate JSON when the request asked for it (default true). */
  requireJson?: boolean | undefined;
}

/**
 * Runs the deterministic guardrail pipeline over a completion's text: JSON validity and
 * schema match (when the request asked for JSON), then policy/PII. **Fails closed** — if a
 * check itself throws (e.g. an uninterpretable schema), the verdict is `block`, never `pass`.
 */
export function runGuardrails(
  request: ChatCompletionRequest,
  responseText: string,
  config: GuardrailConfig,
): GuardrailVerdict {
  let violations: string[];
  try {
    violations = collectViolations(request, responseText, config);
  } catch {
    return { status: 'block', violations: ['guardrail.error'] };
  }
  if (violations.length === 0) return { status: 'pass', violations: [] };
  return { status: config.block ? 'block' : 'flag', violations };
}

function collectViolations(
  request: ChatCompletionRequest,
  responseText: string,
  config: GuardrailConfig,
): string[] {
  const violations: string[] = [];

  const responseFormat = (request as Record<string, unknown>).response_format;
  if (config.requireJson !== false && isJsonRequested(responseFormat)) {
    const parsed = tryParseJson(responseText);
    if (parsed === undefined) {
      violations.push('format.invalid_json');
    } else {
      const schema = extractSchema(responseFormat);
      if (schema !== undefined && !validateAgainstSchema(parsed, schema)) {
        violations.push('format.schema_mismatch');
      }
    }
  }

  violations.push(...detectPolicy(responseText, { blocklist: config.blocklist, pii: config.pii }));
  return violations;
}

function isJsonRequested(responseFormat: unknown): boolean {
  if (typeof responseFormat !== 'object' || responseFormat === null) return false;
  const type = (responseFormat as { type?: unknown }).type;
  return type === 'json_object' || type === 'json_schema';
}

function extractSchema(responseFormat: unknown): unknown {
  if (typeof responseFormat !== 'object' || responseFormat === null) return undefined;
  const jsonSchema = (responseFormat as { json_schema?: unknown }).json_schema;
  if (typeof jsonSchema !== 'object' || jsonSchema === null) return undefined;
  return (jsonSchema as { schema?: unknown }).schema;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // "is this valid JSON" is the check itself — not a hidden failure
  }
}
