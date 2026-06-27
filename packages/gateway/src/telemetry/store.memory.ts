import type { TraceQuery, TraceRecord, TraceStore, VerdictUpdate } from './trace.js';

/** In-memory trace store — used by tests and as a no-database fallback. */
export class InMemoryTraceStore implements TraceStore {
  private readonly traces: TraceRecord[] = [];

  record(trace: TraceRecord): void {
    this.traces.push(trace);
  }

  attachVerdict(id: string, verdict: VerdictUpdate): void {
    const trace = this.traces.find((t) => t.id === id);
    if (trace === undefined) return;
    trace.judgeScore = verdict.judgeScore;
    trace.judgeReason = verdict.judgeReason;
    trace.judgeError = verdict.judgeError;
  }

  query(filter: TraceQuery = {}): TraceRecord[] {
    const matched = this.traces
      .filter((trace) => matches(trace, filter))
      .sort((a, b) => b.timestamp - a.timestamp);
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return matched.slice(offset, offset + limit);
  }

  get(id: string): TraceRecord | undefined {
    return this.traces.find((trace) => trace.id === id);
  }

  close(): void {
    // no resources to release
  }
}

function matches(trace: TraceRecord, filter: TraceQuery): boolean {
  if (filter.model !== undefined && trace.model !== filter.model) return false;
  if (filter.provider !== undefined && trace.provider !== filter.provider) return false;
  if (filter.status !== undefined && trace.status !== filter.status) return false;
  if (filter.stream !== undefined && trace.stream !== filter.stream) return false;
  if (filter.since !== undefined && trace.timestamp < filter.since) return false;
  if (filter.until !== undefined && trace.timestamp > filter.until) return false;
  if (filter.cacheHit !== undefined && trace.cacheHit !== filter.cacheHit) return false;
  if (filter.routedProvider !== undefined && trace.routedProvider !== filter.routedProvider)
    return false;
  if (filter.fallbackUsed !== undefined && trace.fallbackUsed !== filter.fallbackUsed) return false;
  if (filter.guardrailStatus !== undefined && trace.guardrailStatus !== filter.guardrailStatus)
    return false;
  if (filter.judgeScoreMin !== undefined && (trace.judgeScore ?? -Infinity) < filter.judgeScoreMin)
    return false;
  if (filter.judgeScoreMax !== undefined && (trace.judgeScore ?? Infinity) > filter.judgeScoreMax)
    return false;
  if (
    filter.promptFingerprint !== undefined &&
    trace.promptFingerprint !== filter.promptFingerprint
  )
    return false;
  return true;
}
