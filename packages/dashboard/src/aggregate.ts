import type { TraceRecord } from './types';

export interface Count {
  label: string;
  count: number;
}

export interface TimeBucket {
  bucket: number;
  count: number;
  tokens: number;
  errors: number;
}

export interface ScoreBin {
  score: number;
  count: number;
}

export interface Stats {
  total: number;
  errorCount: number;
  errorRate: number;
  cacheHits: number;
  cacheHitRate: number;
  fallbacks: number;
  fallbackRate: number;
  totalTokens: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  judgeScoredCount: number;
  avgJudgeScore: number | null;
  byProvider: Count[];
  byModel: Count[];
  byStatusClass: Count[];
  byGuardrail: Count[];
  judgeHistogram: ScoreBin[];
  overTime: TimeBucket[];
}

const emptyHistogram = (): ScoreBin[] => [1, 2, 3, 4, 5].map((score) => ({ score, count: 0 }));

export const EMPTY_STATS: Stats = {
  total: 0,
  errorCount: 0,
  errorRate: 0,
  cacheHits: 0,
  cacheHitRate: 0,
  fallbacks: 0,
  fallbackRate: 0,
  totalTokens: 0,
  avgLatencyMs: 0,
  p95LatencyMs: 0,
  judgeScoredCount: 0,
  avgJudgeScore: null,
  byProvider: [],
  byModel: [],
  byStatusClass: [],
  byGuardrail: [],
  judgeHistogram: emptyHistogram(),
  overTime: [],
};

/** Nearest-rank percentile of an unsorted array. Returns 0 for an empty input. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index] ?? 0;
}

function tally(items: (string | null)[]): Count[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = item ?? 'unknown';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

function statusClass(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 200) return '2xx';
  return 'other';
}

/** Reduces a window of traces into the dashboard's summary statistics. Pure. */
export function computeStats(traces: TraceRecord[], bucketMs = 60_000): Stats {
  if (traces.length === 0) return { ...EMPTY_STATS, judgeHistogram: emptyHistogram() };

  const total = traces.length;
  let errorCount = 0;
  let cacheHits = 0;
  let fallbacks = 0;
  let totalTokens = 0;
  const latencies: number[] = [];
  const judgeScores: number[] = [];
  const histogram = new Map<number, number>([
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 0],
  ]);
  const buckets = new Map<number, TimeBucket>();

  for (const t of traces) {
    const isError = t.status >= 400;
    if (isError) errorCount++;
    if (t.cacheHit) cacheHits++;
    if (t.fallbackUsed) fallbacks++;
    totalTokens += t.totalTokens ?? 0;
    latencies.push(t.durationMs);
    if (t.judgeScore !== null) {
      judgeScores.push(t.judgeScore);
      const rounded = Math.round(t.judgeScore);
      if (histogram.has(rounded)) histogram.set(rounded, (histogram.get(rounded) ?? 0) + 1);
    }
    const key = Math.floor(t.timestamp / bucketMs) * bucketMs;
    const bucket = buckets.get(key) ?? { bucket: key, count: 0, tokens: 0, errors: 0 };
    bucket.count++;
    bucket.tokens += t.totalTokens ?? 0;
    if (isError) bucket.errors++;
    buckets.set(key, bucket);
  }

  const avgLatency = latencies.reduce((sum, v) => sum + v, 0) / total;
  const avgJudge =
    judgeScores.length > 0
      ? Math.round((judgeScores.reduce((sum, v) => sum + v, 0) / judgeScores.length) * 100) / 100
      : null;

  return {
    total,
    errorCount,
    errorRate: errorCount / total,
    cacheHits,
    cacheHitRate: cacheHits / total,
    fallbacks,
    fallbackRate: fallbacks / total,
    totalTokens,
    avgLatencyMs: Math.round(avgLatency * 100) / 100,
    p95LatencyMs: Math.round(percentile(latencies, 95) * 100) / 100,
    judgeScoredCount: judgeScores.length,
    avgJudgeScore: avgJudge,
    byProvider: tally(traces.map((t) => t.routedProvider ?? t.provider)),
    byModel: tally(traces.map((t) => t.routedModel ?? t.model)),
    byStatusClass: tally(traces.map((t) => statusClass(t.status))),
    byGuardrail: tally(
      traces.filter((t) => t.guardrailStatus !== null).map((t) => t.guardrailStatus),
    ),
    judgeHistogram: [1, 2, 3, 4, 5].map((score) => ({ score, count: histogram.get(score) ?? 0 })),
    overTime: [...buckets.values()].sort((a, b) => a.bucket - b.bucket),
  };
}
