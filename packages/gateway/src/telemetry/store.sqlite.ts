import Database from 'better-sqlite3';
import type { TraceQuery, TraceRecord, TraceStore } from './trace.js';

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
    error_type TEXT,
    error_message TEXT,
    api_key_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON traces (timestamp);
  CREATE INDEX IF NOT EXISTS idx_traces_model ON traces (model);
  CREATE INDEX IF NOT EXISTS idx_traces_status ON traces (status);
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
  error_type: string | null;
  error_message: string | null;
  api_key_hash: string | null;
}

/** SQLite-backed trace store (better-sqlite3, synchronous). Pass ':memory:' for tests. */
export class SqliteTraceStore implements TraceStore {
  private readonly db: InstanceType<typeof Database>;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  record(trace: TraceRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO traces
           (id, trace_id, timestamp, duration_ms, model, provider, stream, status,
            prompt_tokens, completion_tokens, total_tokens, error_type, error_message, api_key_hash)
         VALUES
           (@id, @traceId, @timestamp, @durationMs, @model, @provider, @stream, @status,
            @promptTokens, @completionTokens, @totalTokens, @errorType, @errorMessage, @apiKeyHash)`,
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
        errorType: trace.errorType,
        errorMessage: trace.errorMessage,
        apiKeyHash: trace.apiKeyHash,
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
    errorType: row.error_type,
    errorMessage: row.error_message,
    apiKeyHash: row.api_key_hash,
  };
}
