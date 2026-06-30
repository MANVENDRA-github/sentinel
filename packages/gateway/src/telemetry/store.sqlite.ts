import Database from 'better-sqlite3';
import type { TraceQuery, TraceRecord, TraceStore, VerdictUpdate } from './trace.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    duration_ms REAL NOT NULL,
    model TEXT,
    provider TEXT,
    stream INTEGER NOT NULL,
    status INTEGER NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    cost_usd REAL,
    error_type TEXT,
    error_message TEXT,
    api_key_hash TEXT,
    cache_hit INTEGER NOT NULL DEFAULT 0,
    routed_provider TEXT,
    routed_model TEXT,
    fallback_used INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    guardrail_status TEXT,
    guardrail_violations TEXT,
    judge_score REAL,
    judge_reason TEXT,
    judge_error TEXT,
    prompt_fingerprint TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON traces (timestamp);
  CREATE INDEX IF NOT EXISTS idx_traces_model ON traces (model);
  CREATE INDEX IF NOT EXISTS idx_traces_status ON traces (status);
  CREATE INDEX IF NOT EXISTS idx_traces_cache_hit ON traces (cache_hit);
  CREATE INDEX IF NOT EXISTS idx_traces_fallback_used ON traces (fallback_used);
  CREATE INDEX IF NOT EXISTS idx_traces_guardrail_status ON traces (guardrail_status);
  CREATE INDEX IF NOT EXISTS idx_traces_prompt_fingerprint ON traces (prompt_fingerprint);
`;

interface TraceRow {
  id: string;
  trace_id: string;
  timestamp: number;
  duration_ms: number;
  model: string | null;
  provider: string | null;
  stream: number;
  status: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  error_type: string | null;
  error_message: string | null;
  api_key_hash: string | null;
  cache_hit: number;
  routed_provider: string | null;
  routed_model: string | null;
  fallback_used: number;
  retry_count: number;
  guardrail_status: string | null;
  guardrail_violations: string | null;
  judge_score: number | null;
  judge_reason: string | null;
  judge_error: string | null;
  prompt_fingerprint: string | null;
}

/** SQLite-backed trace store (better-sqlite3, synchronous). Pass ':memory:' for tests. */
export class SqliteTraceStore implements TraceStore {
  private readonly db: InstanceType<typeof Database>;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Adds columns introduced after the initial schema to a pre-existing DB. */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(traces)').all() as { name: string }[]).map((c) => c.name),
    );
    if (!columns.has('cost_usd')) this.db.exec('ALTER TABLE traces ADD COLUMN cost_usd REAL');
  }

  record(trace: TraceRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO traces
           (id, trace_id, timestamp, duration_ms, model, provider, stream, status,
            prompt_tokens, completion_tokens, total_tokens, cost_usd, error_type, error_message, api_key_hash,
            cache_hit, routed_provider, routed_model, fallback_used, retry_count,
            guardrail_status, guardrail_violations, judge_score, judge_reason, judge_error,
            prompt_fingerprint)
         VALUES
           (@id, @traceId, @timestamp, @durationMs, @model, @provider, @stream, @status,
            @promptTokens, @completionTokens, @totalTokens, @costUsd, @errorType, @errorMessage, @apiKeyHash,
            @cacheHit, @routedProvider, @routedModel, @fallbackUsed, @retryCount,
            @guardrailStatus, @guardrailViolations, @judgeScore, @judgeReason, @judgeError,
            @promptFingerprint)`,
      )
      .run({
        id: trace.id,
        traceId: trace.traceId,
        timestamp: trace.timestamp,
        durationMs: trace.durationMs,
        model: trace.model,
        provider: trace.provider,
        stream: trace.stream ? 1 : 0,
        status: trace.status,
        promptTokens: trace.promptTokens,
        completionTokens: trace.completionTokens,
        totalTokens: trace.totalTokens,
        costUsd: trace.costUsd,
        errorType: trace.errorType,
        errorMessage: trace.errorMessage,
        apiKeyHash: trace.apiKeyHash,
        cacheHit: trace.cacheHit ? 1 : 0,
        routedProvider: trace.routedProvider,
        routedModel: trace.routedModel,
        fallbackUsed: trace.fallbackUsed ? 1 : 0,
        retryCount: trace.retryCount,
        guardrailStatus: trace.guardrailStatus,
        guardrailViolations: trace.guardrailViolations,
        judgeScore: trace.judgeScore,
        judgeReason: trace.judgeReason,
        judgeError: trace.judgeError,
        promptFingerprint: trace.promptFingerprint,
      });
  }

  attachVerdict(id: string, verdict: VerdictUpdate): void {
    this.db
      .prepare(
        `UPDATE traces SET judge_score = @judgeScore, judge_reason = @judgeReason,
           judge_error = @judgeError WHERE id = @id`,
      )
      .run({
        id,
        judgeScore: verdict.judgeScore,
        judgeReason: verdict.judgeReason,
        judgeError: verdict.judgeError,
      });
  }

  query(filter: TraceQuery = {}): TraceRecord[] {
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (filter.model !== undefined) {
      where.push('model = @model');
      params.model = filter.model;
    }
    if (filter.provider !== undefined) {
      where.push('provider = @provider');
      params.provider = filter.provider;
    }
    if (filter.status !== undefined) {
      where.push('status = @status');
      params.status = filter.status;
    }
    if (filter.stream !== undefined) {
      where.push('stream = @stream');
      params.stream = filter.stream ? 1 : 0;
    }
    if (filter.since !== undefined) {
      where.push('timestamp >= @since');
      params.since = filter.since;
    }
    if (filter.until !== undefined) {
      where.push('timestamp <= @until');
      params.until = filter.until;
    }
    if (filter.cacheHit !== undefined) {
      where.push('cache_hit = @cacheHit');
      params.cacheHit = filter.cacheHit ? 1 : 0;
    }
    if (filter.routedProvider !== undefined) {
      where.push('routed_provider = @routedProvider');
      params.routedProvider = filter.routedProvider;
    }
    if (filter.fallbackUsed !== undefined) {
      where.push('fallback_used = @fallbackUsed');
      params.fallbackUsed = filter.fallbackUsed ? 1 : 0;
    }
    if (filter.guardrailStatus !== undefined) {
      where.push('guardrail_status = @guardrailStatus');
      params.guardrailStatus = filter.guardrailStatus;
    }
    if (filter.judgeScoreMin !== undefined) {
      where.push('judge_score >= @judgeScoreMin');
      params.judgeScoreMin = filter.judgeScoreMin;
    }
    if (filter.judgeScoreMax !== undefined) {
      where.push('judge_score <= @judgeScoreMax');
      params.judgeScoreMax = filter.judgeScoreMax;
    }
    if (filter.promptFingerprint !== undefined) {
      where.push('prompt_fingerprint = @promptFingerprint');
      params.promptFingerprint = filter.promptFingerprint;
    }
    params.limit = filter.limit ?? 50;
    params.offset = filter.offset ?? 0;
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM traces ${clause} ORDER BY timestamp DESC LIMIT @limit OFFSET @offset`)
      .all(params) as TraceRow[];
    return rows.map(rowToRecord);
  }

  get(id: string): TraceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM traces WHERE id = @id').get({ id }) as
      | TraceRow
      | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: TraceRow): TraceRecord {
  return {
    id: row.id,
    traceId: row.trace_id,
    timestamp: row.timestamp,
    durationMs: row.duration_ms,
    model: row.model,
    provider: row.provider,
    stream: row.stream === 1,
    status: row.status,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    errorType: row.error_type,
    errorMessage: row.error_message,
    apiKeyHash: row.api_key_hash,
    cacheHit: row.cache_hit === 1,
    routedProvider: row.routed_provider,
    routedModel: row.routed_model,
    fallbackUsed: row.fallback_used === 1,
    retryCount: row.retry_count,
    guardrailStatus: row.guardrail_status,
    guardrailViolations: row.guardrail_violations,
    judgeScore: row.judge_score,
    judgeReason: row.judge_reason,
    judgeError: row.judge_error,
    promptFingerprint: row.prompt_fingerprint,
  };
}
