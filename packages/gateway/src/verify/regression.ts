import type { TraceRecord } from '../telemetry/trace.js';

/** Aggregated judge scores for one prompt on one model — the unit of regression comparison. */
export interface RegressionGroup {
  promptFingerprint: string;
  model: string | null;
  count: number;
  meanScore: number;
  minScore: number;
  maxScore: number;
}

/**
 * Groups judge-scored traces by `(promptFingerprint, model)` and summarizes each group.
 * Comparing the groups that share a `promptFingerprint` shows how one prompt's quality
 * differs across models/versions. Traces without a judge score are ignored.
 */
export function aggregateRegression(records: TraceRecord[]): RegressionGroup[] {
  const groups = new Map<string, { fingerprint: string; model: string | null; scores: number[] }>();

  for (const record of records) {
    if (record.judgeScore === null || record.promptFingerprint === null) continue;
    const key = `${record.promptFingerprint}::${record.model ?? ''}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { fingerprint: record.promptFingerprint, model: record.model, scores: [] };
      groups.set(key, group);
    }
    group.scores.push(record.judgeScore);
  }

  const result: RegressionGroup[] = [];
  for (const group of groups.values()) {
    const count = group.scores.length;
    const sum = group.scores.reduce((total, score) => total + score, 0);
    result.push({
      promptFingerprint: group.fingerprint,
      model: group.model,
      count,
      meanScore: Math.round((sum / count) * 1000) / 1000,
      minScore: Math.min(...group.scores),
      maxScore: Math.max(...group.scores),
    });
  }

  result.sort(
    (a, b) =>
      a.promptFingerprint.localeCompare(b.promptFingerprint) ||
      (a.model ?? '').localeCompare(b.model ?? ''),
  );
  return result;
}
