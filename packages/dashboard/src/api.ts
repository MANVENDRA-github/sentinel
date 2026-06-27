import type { RegressionGroup, TraceRecord } from './types';

export interface ApiConfig {
  /** Gateway origin, e.g. `http://localhost:8080`, or `''` for same-origin (dev proxy). */
  baseUrl: string;
  /** The gateway's `SENTINEL_ADMIN_KEY`. */
  adminKey: string;
}

async function getJson<T>(path: string, config: ApiConfig, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${config.adminKey}` },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw new Error(`Request to ${path} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function fetchTraces(
  config: ApiConfig,
  limit = 500,
  signal?: AbortSignal,
): Promise<TraceRecord[]> {
  return getJson<TraceRecord[]>(`/traces?limit=${String(limit)}`, config, signal);
}

export function fetchRegression(
  config: ApiConfig,
  signal?: AbortSignal,
): Promise<RegressionGroup[]> {
  return getJson<RegressionGroup[]>('/regression', config, signal);
}
