import type { FastifyPluginAsync } from 'fastify';
import { createAdminAuthHook, createAuthHook, extractBearerToken, hashApiKey } from './auth.js';
import { AuthError } from './errors.js';
import type { TraceQuery, TraceStore } from './telemetry/trace.js';

export interface TraceRoutesOptions {
  traceStore: TraceStore;
  adminKey: string | undefined;
  /** Client API keys, for the self-scoped `/v1/traces` endpoints. */
  apiKeys: ReadonlySet<string>;
}

/**
 * Fastify plugin: an admin-key-gated read API over all traces (`/traces`), plus a
 * self-scoped read API (`/v1/traces`) where a client key sees only its own traces.
 */
export const traceRoutes: FastifyPluginAsync<TraceRoutesOptions> = async (app, options) => {
  const adminHook = createAdminAuthHook(options.adminKey);
  const authHook = createAuthHook(options.apiKeys);

  app.get('/traces', { preHandler: adminHook }, async (request, reply) => {
    return reply.send(options.traceStore.query(parseTraceQuery(request.query)));
  });

  app.get('/traces/:id', { preHandler: adminHook }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const trace = options.traceStore.get(id);
    if (trace === undefined) {
      return reply
        .status(404)
        .send({ error: { message: `No trace "${id}"`, type: 'not_found', code: null } });
    }
    return reply.send(trace);
  });

  // Self-scoped: a client key reads only its own traces (forced apiKeyHash filter).
  app.get('/v1/traces', { preHandler: authHook }, async (request, reply) => {
    const query = parseTraceQuery(request.query);
    query.apiKeyHash = callerHash(request.headers.authorization);
    return reply.send(options.traceStore.query(query));
  });

  app.get('/v1/traces/:id', { preHandler: authHook }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const trace = options.traceStore.get(id);
    if (trace === undefined || trace.apiKeyHash !== callerHash(request.headers.authorization)) {
      return reply
        .status(404)
        .send({ error: { message: `No trace "${id}"`, type: 'not_found', code: null } });
    }
    return reply.send(trace);
  });
};

/** Hashes the caller's bearer token so they can be scoped to their own traces. */
function callerHash(authorization: string | undefined): string {
  const token = extractBearerToken(authorization);
  if (token === null) throw new AuthError(); // authHook already guarantees one; defensive
  return hashApiKey(token);
}

function parseTraceQuery(raw: unknown): TraceQuery {
  const q = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
    string,
    string | undefined
  >;
  const query: TraceQuery = {};
  if (q.model !== undefined) query.model = q.model;
  if (q.provider !== undefined) query.provider = q.provider;
  if (q.status !== undefined) query.status = Number(q.status);
  if (q.stream !== undefined) query.stream = q.stream === 'true';
  if (q.since !== undefined) query.since = Number(q.since);
  if (q.until !== undefined) query.until = Number(q.until);
  if (q.cacheHit !== undefined) query.cacheHit = q.cacheHit === 'true';
  if (q.routedProvider !== undefined) query.routedProvider = q.routedProvider;
  if (q.fallbackUsed !== undefined) query.fallbackUsed = q.fallbackUsed === 'true';
  if (q.guardrailStatus !== undefined) query.guardrailStatus = q.guardrailStatus;
  if (q.judgeScoreMin !== undefined) query.judgeScoreMin = Number(q.judgeScoreMin);
  if (q.judgeScoreMax !== undefined) query.judgeScoreMax = Number(q.judgeScoreMax);
  if (q.promptFingerprint !== undefined) query.promptFingerprint = q.promptFingerprint;
  if (q.limit !== undefined) query.limit = Math.min(Number(q.limit), 500);
  if (q.offset !== undefined) query.offset = Number(q.offset);
  return query;
}
