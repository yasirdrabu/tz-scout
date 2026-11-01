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
const withKey = (secret: string) => new Request('http://x/api/v1/y', { headers: { authorization: `Bearer ${secret}` } });
const withCookie = (cookies: Headers) => {
  const h = new Headers(cookies);
  h.set('x-scout-tenant', slug);
  return new Request('http://localhost:4240/api/v1/y', { headers: h });
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

describe('the brief routes and their permissions', () => {
  it.each([
    ['GET', 'accounts/acc_1/brief', 'playbooks:read'],
    ['PUT', 'accounts/acc_1/brief/sections/overview', 'playbooks:write'],
    ['POST', 'accounts/acc_1:draft-brief', 'playbooks:write'],
  ])('%s %s needs %s', async (method, path, scope) => {
    const { GET } = await import('@/http/routes/v1/accounts/[id]/brief/route');
    const { PUT } = await import('@/http/routes/v1/accounts/[id]/brief/sections/[key]/route');
    const { POST } = await import('@/http/routes/v1/accounts/[id]/route');
    const route = { GET, PUT, POST }[method as 'GET' | 'PUT' | 'POST'];
    const res = await route(
      new Request(`http://x/api/v1/${path}`, {
        method,
        headers: { authorization: `Bearer ${await apiKey()}`, 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: JSON.stringify({ body: 'Hi' }) }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toBe(`This key can't do that. It needs the \`${scope}\` scope.`);
  });
});

describe('the polish routes and their permissions', () => {
  it('GET scoring/last-rescore needs review:act', async () => {
    const { GET } = await import('@/http/routes/v1/scoring/last-rescore/route');
    const res = await GET(new Request('http://x/api/v1/scoring/last-rescore', { headers: { authorization: `Bearer ${await apiKey()}` } }));
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toBe("This key can't do that. It needs the `review:act` scope.");
    expect((await GET(withCookie(ownerHeaders))).status).toBe(200);
  });

  it('POST review-queue/assign-preview needs assign:act and a person', async () => {
    const { POST } = await import('@/http/routes/v1/review-queue/assign-preview/route');
    const res = await POST(
      new Request('http://x/api/v1/review-queue/assign-preview', {
        method: 'POST',
        headers: { authorization: `Bearer ${await apiKey()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ account_ids: ['acc_1'], seller_user_id: 'usr_1' }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe('the sources routes and their permissions', () => {
  const asKey = async (path: string, method = 'GET', body?: unknown) =>
    new Request(`http://x/api/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${await apiKey()}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it.each([
    ['GET', 'sources/stats', 'sources:manage', () => import('@/http/routes/v1/sources/stats/route')],
    ['GET', 'sources/src_1', 'sources:manage', () => import('@/http/routes/v1/sources/[id]/route')],
    ['DELETE', 'sources/src_1', 'sources:manage', () => import('@/http/routes/v1/sources/[id]/route')],
    ['POST', 'sources/src_1:sync', 'sources:manage', () => import('@/http/routes/v1/sources/[id]/route')],
    ['POST', 'sources/src_1/keys/key_1:rotate', 'sources:manage', () => import('@/http/routes/v1/sources/[id]/keys/[keyId]/route')],
    ['DELETE', 'sources/src_1/keys/key_1', 'sources:manage', () => import('@/http/routes/v1/sources/[id]/keys/[keyId]/route')],
    ['GET', 'members/directory', 'members:read', () => import('@/http/routes/v1/members/directory/route')],
  ] as const)('%s %s needs %s', async (method, path, scope, load) => {
    const mod = (await load()) as Record<string, (r: Request) => Promise<Response>>;
    const res = await mod[method]!(await asKey(path, method, method === 'POST' ? {} : undefined));
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toBe(`This key can't do that. It needs the \`${scope}\` scope.`);
  });

  it('GET feedback?source_id needs sources:manage', async () => {
    const { GET } = await import('@/http/routes/v1/feedback/route');
    const key = (
      await inTenant(tenantId, owner.actor, (ctx) => createApiKey(ctx, { name: 'r', environment: 'live', scopes: ['arrivals:read'] }, SYSTEM_GRANTOR))
    ).secret;
    const res = await GET(new Request('http://x/api/v1/feedback?source_id=src_1', { headers: { authorization: `Bearer ${key}` } }));
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toBe("This key can't do that. It needs the `sources:manage` scope.");
  });
});
