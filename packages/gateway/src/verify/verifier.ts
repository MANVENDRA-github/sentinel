import type { ChatCompletionRequest } from '../schemas.js';
import type { TraceStore } from '../telemetry/trace.js';
import type { Judge } from './judge.js';
import { runGuardrails } from './guardrails.js';
import type { GuardrailConfig, GuardrailVerdict } from './guardrails.js';
import { promptFingerprint } from './fingerprint.js';

/** Orchestrates inline guardrails (sync) and the sampled, out-of-band judge (async). */
export interface Verifier {
  /** Runs deterministic guardrails on a response. Pass-through when guardrails are unconfigured. */
  inspect(request: ChatCompletionRequest, responseText: string): GuardrailVerdict;
  /** Model-independent prompt fingerprint for regression grouping. */
  fingerprint(request: ChatCompletionRequest): string;
  /** Fire-and-forget: if sampled, scores the response and attaches the verdict to the trace. */
  scheduleJudge(spanId: string, request: ChatCompletionRequest, responseText: string): void;
  /** Awaits all in-flight judge work (graceful shutdown + tests). */
  drain(): Promise<void>;
}

export interface VerifierOptions {
  store: TraceStore;
  /** Guardrail config; omit to disable inline guardrails (every response passes). */
  guardrails?: GuardrailConfig | undefined;
  /** Judge client; omit to disable judging. */
  judge?: Judge | undefined;
  /** Fraction of traffic to judge (0–1); used by the default sampler. */
  sampleRate?: number | undefined;
  /** Injectable sampling decision (defaults to `Math.random() < sampleRate`). */
  shouldSample?: (() => boolean) | undefined;
  /** Max stored length of the judge's reason text. */
  reasonMaxLength?: number | undefined;
}

const PASS: GuardrailVerdict = { status: 'pass', violations: [] };

export function createVerifier(options: VerifierOptions): Verifier {
  const { store, guardrails, judge } = options;
  const rate = options.sampleRate ?? 0;
  const shouldSample = options.shouldSample ?? ((): boolean => Math.random() < rate);
  const reasonMax = options.reasonMaxLength ?? 280;
  const inflight = new Set<Promise<void>>();

  return {
    inspect(request, responseText): GuardrailVerdict {
      if (guardrails === undefined) return PASS;
      return runGuardrails(request, responseText, guardrails);
    },

    fingerprint(request): string {
      return promptFingerprint(request);
    },

    scheduleJudge(spanId, request, responseText): void {
      if (judge === undefined || !shouldSample()) return;
      const task = judge
        .score(request, responseText)
        .then((verdict) => {
          store.attachVerdict(spanId, {
            judgeScore: verdict.score,
            judgeReason: verdict.reason.slice(0, reasonMax),
            judgeError: null,
          });
        })
        .catch((error: unknown) => {
          // Fail-open: a judge failure is recorded as "unscored", never as a pass.
          store.attachVerdict(spanId, {
            judgeScore: null,
            judgeReason: null,
            judgeError: error instanceof Error ? error.message : String(error),
          });
        });
      inflight.add(task);
      void task.finally(() => inflight.delete(task));
    },

    async drain(): Promise<void> {
      await Promise.all([...inflight]);
    },
  };
}
