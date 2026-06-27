/**
 * Local mirror of the gateway's trace contract
 * (`packages/gateway/src/telemetry/trace.ts` and `verify/regression.ts`).
 * Kept here so the UI never depends on the gateway's build.
 */
export interface TraceRecord {
  id: string;
  traceId: string;
  timestamp: number;
  durationMs: number;
  model: string | null;
  provider: string | null;
  stream: boolean;
  status: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  errorType: string | null;
  errorMessage: string | null;
  apiKeyHash: string | null;
  cacheHit: boolean;
  routedProvider: string | null;
  routedModel: string | null;
  fallbackUsed: boolean;
  retryCount: number;
  guardrailStatus: string | null;
  guardrailViolations: string | null;
  judgeScore: number | null;
  judgeReason: string | null;
  judgeError: string | null;
  promptFingerprint: string | null;
}

export interface RegressionGroup {
  promptFingerprint: string;
  model: string | null;
  count: number;
  meanScore: number;
  minScore: number;
  maxScore: number;
}
