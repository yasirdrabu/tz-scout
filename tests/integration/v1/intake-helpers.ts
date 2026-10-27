import '@/entry/compose';
import { SYSTEM_GRANTOR, createApiKey, setPrincipalCacheTtl, type Permission } from '@/modules/tenancy';
import { freshTenant, personAndAgent, type Tenant } from '../intake/helpers';

export { freshTenant, personAndAgent, type Tenant };

export const SEND: Permission[] = ['arrivals:write', 'arrivals:read'];

/** An API key for the tenant; the secret is the bearer token. */
export async function keyFor(
  t: Tenant,
  scopes: Permission[],
  extra: { sourceId?: string; dataLimit?: Parameters<typeof createApiKey>[1]['dataLimit'] } = {},
): Promise<string> {
  setPrincipalCacheTtl(0);
  const k = await t.run((ctx) => createApiKey(ctx, { name: 'k', environment: 'live', scopes, ...extra }, SYSTEM_GRANTOR));
  return k.secret;
}

/** Calls a route handler the way the HTTP layer would. `body` is JSON unless it is a string or FormData. */
export function call(
  handler: (r: Request) => Promise<Response>,
  secret: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const { body } = init;
  const isForm = body instanceof FormData;
  return handler(
    new Request(`http://x/v1/${path}`, {
      method: init.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${secret}`,
        ...(isForm || body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(body === undefined ? {} : { body: isForm || typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
  );
}

export const uploadForm = (name: string, content: string | Uint8Array, fields: Record<string, string> = {}, type = 'text/csv') => {
  const f = new FormData();
  f.set('file', new File([content as BlobPart], name, { type }));
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
