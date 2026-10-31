import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v1Route } from '@/http/routes/v1/_lib/v1-route';
import { SYSTEM_GRANTOR, createApiKey, createTenant, handleDevSignIn, setPrincipalCacheTtl } from '@/modules/tenancy';
import { membership } from '@/modules/tenancy/db/schema';
import type { ModuleContext } from '@/platform/context';
import { adminDb } from '@/platform/db/client';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';

let tenantId: string;
let slug: string;
let owner: Awaited<ReturnType<typeof seedUser>>;
let ownerHeaders: Headers;

async function signedIn(userId: string): Promise<Headers> {
  const res = await handleDevSignIn(
    new Request('http://localhost:4240/api/dev/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    }),
    { enabled: true },
  );
  return new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ') });
}

beforeAll(async () => {
  const admin = await seedUser({ admin: true });
  owner = await seedUser({ signedIn: true });
  slug = uniqueSlug();
  const t = await createTenant(admin.actor, {
    slug,
    name: 'Access Co',
    currency: 'USD',
    timezone: 'UTC',
    ownerEmail: owner.email,
  });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  tenantId = t.tenantId;
  ownerHeaders = await signedIn(owner.id);
});
beforeEach(() => setPrincipalCacheTtl(0));

const apiKey = async () =>
  (
    await inTenant(tenantId, owner.actor, (ctx) =>
      createApiKey(ctx, { name: 'k', environment: 'live', scopes: [] }, SYSTEM_GRANTOR),
    )
  ).secret;
const withKey = (secret: string) => new Request('http://x/v1/y', { headers: { authorization: `Bearer ${secret}` } });
const withCookie = (cookies: Headers) => {
  const h = new Headers(cookies);
  h.set('x-scout-tenant', slug);
  return new Request('http://localhost:4240/v1/y', { headers: h });
};

// The owner's person source is created the first time they act.
const ownerAccess = { dataLimit: { kind: 'all' }, sourceId: expect.stringMatching(/^src_/), childSourceIds: [] };

describe('ctx.access', () => {
  it('v1Route gives the handler the principal data limit', async () => {
    let seen: ModuleContext['access'];
    const route = v1Route({}, async (_r, _p, ctx) => {
      seen = ctx.access;
      return {};
    });
    expect((await route(withKey(await apiKey()))).status).toBe(200);
    expect(seen).toEqual({ dataLimit: { kind: 'own_source' } });
    expect((await route(withCookie(ownerHeaders))).status).toBe(200);
    expect(seen).toEqual({ ...ownerAccess, userId: owner.id });
  });
});

describe('route guards', () => {
  it('peopleOnly refuses an API key with 403 and lets a person in', async () => {
    const route = v1Route({ peopleOnly: true }, async () => ({ ok: true }));
    const res = await route(withKey(await apiKey()));
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toBe('Only a person can do this.');
    expect((await route(withCookie(ownerHeaders))).status).toBe(200);
  });

  it('peopleOnly uses the copy the route passes', async () => {
    const route = v1Route({ peopleOnly: 'Sign in to do this.' }, async () => ({}));
    expect((await (await route(withKey(await apiKey()))).json()).detail).toBe('Sign in to do this.');
  });

  it('platformAdminOnly refuses members and API keys, admits a platform admin', async () => {
    const route = v1Route({ platformAdminOnly: true }, async () => ({ ok: true }));
    expect((await route(withKey(await apiKey()))).status).toBe(403);
    expect((await route(withCookie(ownerHeaders))).status).toBe(403);
    const admin = await seedUser({ admin: true, signedIn: true });
    expect((await route(withCookie(await signedIn(admin.id)))).status).toBe(200);
  });
});
