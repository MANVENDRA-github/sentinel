import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchRegression, fetchTraces } from './api';
import type { ApiConfig } from './api';
import { computeStats } from './aggregate';
import type { RegressionGroup, TraceRecord } from './types';
import {
  BarChart,
  Histogram,
  RegressionPanel,
  Sparkline,
  StatCard,
  TracesTable,
} from './components';

const KEY_ADMIN = 'sentinel.adminKey';
const KEY_BASE = 'sentinel.baseUrl';

function pct(value: number): string {
  return `${String(Math.round(value * 1000) / 10)}%`;
}

export function App() {
  const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem(KEY_BASE) ?? '');
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem(KEY_ADMIN) ?? '');
  const [traces, setTraces] = useState<TraceRecord[]>([]);
  const [regression, setRegression] = useState<RegressionGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (adminKey === '') {
      setError('Enter your gateway admin key to load traces.');
      return;
    }
    const config: ApiConfig = { baseUrl, adminKey };
    setLoading(true);
    setError(null);
    try {
      const [t, r] = await Promise.all([fetchTraces(config), fetchRegression(config)]);
      setTraces(t);
      setRegression(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [baseUrl, adminKey]);

  useEffect(() => {
    localStorage.setItem(KEY_BASE, baseUrl);
    localStorage.setItem(KEY_ADMIN, adminKey);
  }, [baseUrl, adminKey]);

  // Auto-load once on mount if an admin key is already stored; later loads are via Refresh.
  useEffect(() => {
    if (adminKey !== '') void load();
  }, []);

  const stats = useMemo(() => computeStats(traces), [traces]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Sentinel</h1>
        <div className="controls">
          <input
            aria-label="Gateway URL"
            placeholder="gateway URL (blank = same origin)"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
            }}
          />
          <input
            aria-label="Admin key"
            type="password"
            placeholder="admin key"
            value={adminKey}
            onChange={(e) => {
              setAdminKey(e.target.value);
            }}
          />
          <button
            onClick={() => {
              void load();
            }}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error !== null ? (
        <div className="banner err" role="alert">
          {error}
        </div>
      ) : null}

      <section className="stats-row">
        <StatCard testId="stat-total" label="Requests" value={String(stats.total)} />
        <StatCard
          testId="stat-error"
          label="Error rate"
          value={pct(stats.errorRate)}
          sub={`${String(stats.errorCount)} errors`}
        />
        <StatCard
          testId="stat-cache"
          label="Cache hit rate"
          value={pct(stats.cacheHitRate)}
          sub={`${String(stats.cacheHits)} hits`}
        />
        <StatCard
          testId="stat-fallback"
          label="Fallback rate"
          value={pct(stats.fallbackRate)}
          sub={`${String(stats.fallbacks)} fell back`}
        />
        <StatCard
          testId="stat-latency"
          label="Latency p95"
          value={`${String(stats.p95LatencyMs)} ms`}
          sub={`avg ${String(stats.avgLatencyMs)} ms`}
        />
        <StatCard testId="stat-tokens" label="Tokens" value={stats.totalTokens.toLocaleString()} />
        <StatCard
          testId="stat-judge"
          label="Avg judge score"
          value={stats.avgJudgeScore !== null ? String(stats.avgJudgeScore) : '—'}
          sub={`${String(stats.judgeScoredCount)} scored`}
        />
      </section>

      <section className="grid">
        <Sparkline title="Requests over time" buckets={stats.overTime} />
        <BarChart title="By provider" data={stats.byProvider} />
        <BarChart title="By model" data={stats.byModel} />
        <BarChart title="By status" data={stats.byStatusClass} />
        <BarChart title="Guardrails" data={stats.byGuardrail} />
        <Histogram title="Judge scores" bins={stats.judgeHistogram} />
      </section>

      <RegressionPanel groups={regression} />
      <TracesTable traces={traces} />
    </div>
  );
}
