/** Error types and OpenAI-style error mapping for the gateway. */

export interface OpenAIErrorBody {
  error: { message: string; type: string; code: string | null };
}

/** A request-level error that maps to an HTTP status and an OpenAI-style body. */
export class GatewayError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;

  constructor(status: number, message: string, type: string, code: string | null = null) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.type = type;
    this.code = code;
  }

  toBody(): OpenAIErrorBody {
    return { error: { message: this.message, type: this.type, code: this.code } };
  }
}

/** The request body failed validation. */
export class ValidationError extends GatewayError {
  constructor(message: string) {
    super(400, message, 'invalid_request_error', 'invalid_body');
  }
}

/** The Sentinel API key was missing or invalid. */
export class AuthError extends GatewayError {
  constructor(message = 'Missing or invalid API key') {
    super(401, message, 'invalid_request_error', 'invalid_api_key');
  }
}

/** No provider is configured for the requested model. */
export class ModelNotFoundError extends GatewayError {
  constructor(model: string) {
    super(
      404,
      `No provider is configured for model "${model}"`,
      'invalid_request_error',
      'model_not_found',
    );
  }
}

/** The upstream provider returned an error. 4xx pass through; 5xx collapse to 502. */
export class UpstreamError extends GatewayError {
  constructor(provider: string, upstreamStatus: number, detail: string) {
    const status = upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : 502;
    super(
      status,
      `Upstream provider "${provider}" failed: ${detail}`,
      'upstream_error',
      'upstream_error',
    );
  }

  static async fromResponse(provider: string, res: Response): Promise<UpstreamError> {
    let detail = res.statusText || `HTTP ${res.status}`;
    try {
      const text = await res.text();
      if (text.length > 0) detail = text.slice(0, 500);
    } catch {
      detail = res.statusText || `HTTP ${res.status}`;
    }
    return new UpstreamError(provider, res.status, detail);
  }
}

/** The response failed an inline guardrail and blocking is enabled. */
export class GuardrailBlockedError extends GatewayError {
  constructor(violations: string[]) {
    super(
      422,
      `Response blocked by guardrails: ${violations.join(', ')}`,
      'guardrail_blocked',
      'guardrail_blocked',
    );
  }
}

/** A single API key exceeded its inbound request-per-minute budget. */
export class RateLimitedError extends GatewayError {
  constructor(message = 'Rate limit exceeded for this API key') {
    super(429, message, 'rate_limit_error', 'rate_limited');
  }
}

/** A startup/configuration error (not request-scoped). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
