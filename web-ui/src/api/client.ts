import { errorFrom, networkError } from './errors';

/** Where the API lives. Moves to '/api/v1' with spec C1. */
export const API_BASE = '/v1';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RequestOptions = {
  method?: Method;
  body?: unknown;
  signal?: AbortSignal;
  /** Workspace slug, sent as `x-scout-tenant`. */
  tenant?: string;
  /** Send an `Idempotency-Key`, so a retried POST runs once. */
  idempotent?: boolean;
};

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** One id per request; the API echoes it and errors show it as the error ref. */
export const newCorrelationId = () => `web-${randomId()}`;

async function readJson(res: Response): Promise<unknown> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Fetch with the session cookie and JSON, failing with ApiError (UnauthorizedError on 401). */
export async function request<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, tenant, idempotent = false } = opts;
  const correlationId = newCorrelationId();
  const headers = new Headers({ accept: 'application/json, application/problem+json', 'x-correlation-id': correlationId });
  if (tenant) headers.set('x-scout-tenant', tenant);
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (idempotent) headers.set('idempotency-key', crypto.randomUUID());

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw networkError(correlationId);
  }

  const ref = res.headers.get('x-correlation-id') ?? correlationId;
  if (!res.ok) throw errorFrom(res.status, await readJson(res), ref);
  if (res.status === 204) return undefined as T;
  return (await readJson(res)) as T;
}

/** A call to the Scout API: `apiFetch('/me', { tenant })`. Every POST carries an Idempotency-Key. */
export function apiFetch<T>(path: string, opts: Omit<RequestOptions, 'idempotent'> = {}): Promise<T> {
  return request<T>(API_BASE + path, { ...opts, idempotent: opts.method === 'POST' });
}
