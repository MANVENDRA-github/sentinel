import type { FastifyPluginAsync } from 'fastify';
import { createAdminAuthHook } from './auth.js';
import type { TraceQuery, TraceStore } from './telemetry/trace.js';
import { aggregateRegression } from './verify/regression.js';

export interface RegressionRoutesOptions {
  traceStore: TraceStore;
  adminKey: string | undefined;
}

/**
 * Fastify plugin: an admin-gated `GET /regression` that summarizes judge scores grouped by
 * `(promptFingerprint, model)` — compare the groups sharing a fingerprint to see how one
 * prompt's quality differs across models/versions.
 */
export const regressionRoutes: FastifyPluginAsync<RegressionRoutesOptions> = async (
  app,
  options,
) => {
  const adminHook = createAdminAuthHook(options.adminKey);

  app.get('/regression', { preHandler: adminHook }, async (request, reply) => {
    const q = (
      typeof request.query === 'object' && request.query !== null ? request.query : {}
    ) as Record<string, string | undefined>;
    const filter: TraceQuery = { limit: 500 };
    if (q.model !== undefined) filter.model = q.model;
    if (q.promptFingerprint !== undefined) filter.promptFingerprint = q.promptFingerprint;
    if (q.since !== undefined) filter.since = Number(q.since);
    return reply.send(aggregateRegression(options.traceStore.query(filter)));
  });
};
