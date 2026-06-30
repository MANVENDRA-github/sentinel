import type { Count, ScoreBin, TimeBucket } from './aggregate';
import type { RegressionGroup, TraceRecord } from './types';

export function StatCard(props: { label: string; value: string; sub?: string; testId?: string }) {
  return (
    <div className="card stat" data-testid={props.testId}>
      <div className="stat-label">{props.label}</div>
      <div className="stat-value">{props.value}</div>
      {props.sub !== undefined ? <div className="stat-sub">{props.sub}</div> : null}
    </div>
  );
}

export function BarChart(props: { title: string; data: Count[] }) {
  const max = Math.max(1, ...props.data.map((d) => d.count));
  return (
    <div className="card">
      <h3>{props.title}</h3>
      {props.data.length === 0 ? (
        <div className="empty">no data</div>
      ) : (
        <ul className="bars">
          {props.data.map((d) => (
            <li key={d.label}>
              <span className="bar-label" title={d.label}>
                {d.label}
              </span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${String((d.count / max) * 100)}%` }} />
              </span>
              <span className="bar-count">{d.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Histogram(props: { title: string; bins: ScoreBin[] }) {
  const max = Math.max(1, ...props.bins.map((b) => b.count));
  return (
    <div className="card">
      <h3>{props.title}</h3>
      <div className="histogram">
        {props.bins.map((b) => (
          <div className="hist-col" key={b.score}>
            <div
              className="hist-bar"
              style={{ height: `${String((b.count / max) * 100)}%` }}
              title={`${String(b.count)} scored ${String(b.score)}`}
            />
            <div className="hist-axis">{b.score}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Sparkline(props: {
  title: string;
  buckets: TimeBucket[];
  value?: (b: TimeBucket) => number;
}) {
  const pts = props.buckets;
  const value = props.value ?? ((b: TimeBucket) => b.count);
  const width = 280;
  const height = 60;
  const max = Math.max(1, ...pts.map((p) => value(p)));
  const path = pts
    .map((p, i) => {
      const x = pts.length > 1 ? (i / (pts.length - 1)) * width : 0;
      const y = height - (value(p) / max) * height;
      return `${i === 0 ? 'M' : 'L'}${String(Math.round(x))},${String(Math.round(y))}`;
    })
    .join(' ');
  return (
    <div className="card">
      <h3>{props.title}</h3>
      {pts.length > 1 ? (
        <svg
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          className="spark"
          preserveAspectRatio="none"
        >
          <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      ) : (
        <div className="empty">not enough data yet</div>
      )}
    </div>
  );
}

export function TracesTable(props: { traces: TraceRecord[] }) {
  return (
    <div className="card wide">
      <h3>Recent requests</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>time</th>
              <th>model</th>
              <th>provider</th>
              <th>status</th>
              <th>tokens</th>
              <th>ms</th>
              <th>cache</th>
              <th>guardrail</th>
              <th>judge</th>
            </tr>
          </thead>
          <tbody>
            {props.traces.slice(0, 50).map((t) => (
              <tr key={t.id} className={t.status >= 400 ? 'err' : ''}>
                <td>{new Date(t.timestamp).toLocaleTimeString()}</td>
                <td>{t.routedModel ?? t.model ?? '—'}</td>
                <td>{t.routedProvider ?? t.provider ?? '—'}</td>
                <td>{t.status}</td>
                <td>{t.totalTokens ?? '—'}</td>
                <td>{Math.round(t.durationMs)}</td>
                <td>{t.cacheHit ? '✓' : ''}</td>
                <td>{t.guardrailStatus ?? '—'}</td>
                <td>{t.judgeScore ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RegressionPanel(props: { groups: RegressionGroup[] }) {
  return (
    <div className="card wide">
      <h3>Quality regressions (judge score by prompt × model)</h3>
      {props.groups.length === 0 ? (
        <div className="empty">no judge-scored traces yet</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>fingerprint</th>
                <th>model</th>
                <th>n</th>
                <th>mean</th>
                <th>min</th>
                <th>max</th>
              </tr>
            </thead>
            <tbody>
              {props.groups.map((g) => (
                <tr key={`${g.promptFingerprint}:${g.model ?? ''}`}>
                  <td className="mono">{g.promptFingerprint.slice(0, 12)}</td>
                  <td>{g.model ?? '—'}</td>
                  <td>{g.count}</td>
                  <td>{g.meanScore}</td>
                  <td>{g.minScore}</td>
                  <td>{g.maxScore}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
