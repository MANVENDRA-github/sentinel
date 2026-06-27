import { createHash } from 'node:crypto';
import { AuthError } from './errors.js';

/** Extracts the bearer token from an Authorization header, or null if absent/malformed. */
export function extractBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const token = match?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : null;
}

/** Minimal request shape the hook needs — keeps it decoupled from Fastify's generics. */
interface RequestWithAuth {
  headers: { authorization?: string | undefined };
}

/** Builds a Fastify preHandler that requires a valid Sentinel API key. */
export function createAuthHook(apiKeys: ReadonlySet<string>) {
  return async function authHook(request: RequestWithAuth): Promise<void> {
    const token = extractBearerToken(request.headers.authorization);
    if (token === null || !apiKeys.has(token)) {
      throw new AuthError();
    }
  };
}

/** Builds a preHandler that requires the configured admin key (for trace/admin endpoints). */
export function createAdminAuthHook(adminKey: string | undefined) {
  return async function adminAuthHook(request: RequestWithAuth): Promise<void> {
    const token = extractBearerToken(request.headers.authorization);
    if (adminKey === undefined || adminKey.length === 0 || token !== adminKey) {
      throw new AuthError('Admin access required');
    }
  };
}

/** SHA-256 hex digest of an API key, so raw keys are never persisted in traces. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
