import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { createTenant, handleDevSignIn } from '@/modules/tenancy';
import { membership } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { seedUser, uniqueSlug } from '../tenancy/helpers';

export const ORIGIN = 'http://localhost:4240';

export type Person = Awaited<ReturnType<typeof seedUser>>;

/** Signs the user in through dev sign-in and returns the session cookie header. */
export async function signedIn(userId: string, headers: Record<string, string> = {}): Promise<Headers> {
  const res = await handleDevSignIn(
    new Request(`${ORIGIN}/api/dev/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ userId }),
    }),
    { enabled: true },
  );
  expect(res.status).toBe(200);
  return new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ') });
}

/** A tenant whose owner (`ownerEmail`) is already active. */
export async function tenantOwnedBy(by: Person, ownerEmail: string, name = 'Acme') {
  const slug = uniqueSlug();
  const t = await createTenant(by.actor, { slug, name, currency: 'EUR', timezone: 'Europe/Berlin', ownerEmail });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  return { tenantId: t.tenantId, slug, ownerMembershipId: t.ownerMembershipId };
}

export type ReqOpts = {
  cookies?: Headers;
  tenant?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

/** A request to `/v1{path}`. Writes carry our Origin, so the CSRF check passes. */
export function v1Req(path: string, opts: ReqOpts = {}): Request {
  const h = new Headers(opts.cookies);
  if (opts.tenant) h.set('x-scout-tenant', opts.tenant);
  if (opts.method && opts.method !== 'GET') h.set('origin', ORIGIN);
  if (opts.body !== undefined) h.set('content-type', 'application/json');
  for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, v);
  return new Request(`${ORIGIN}/v1${path}`, {
    method: opts.method ?? 'GET',
    headers: h,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}
