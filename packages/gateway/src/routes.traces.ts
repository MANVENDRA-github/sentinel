import type { FastifyPluginAsync } from 'fastify';
import { createAdminAuthHook } from './auth.js';
import type { TraceQuery, TraceStore } from './telemetry/trace.js';

export interface TraceRoutesOptions {
  traceStore: TraceStore;
  adminKey: string | undefined;
}

/** Fastify plugin: an admin-key-gated read API over the trace store. */
export const traceRoutes: FastifyPluginAsync<TraceRoutesOptions> = async (app, options) => {
  const adminHook = createAdminAuthHook(options.adminKey);

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
};

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
  if (q.limit !== undefined) query.limit = Math.min(Number(q.limit), 500);
  if (q.offset !== undefined) query.offset = Number(q.offset);
  return query;
}
