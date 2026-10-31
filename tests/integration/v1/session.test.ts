import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as me } from '@/app/v1/me/route';
import { GET as counts } from '@/app/v1/me/counts/route';
import { PUT as putWorkspace } from '@/app/v1/me/workspace/route';
import { adminRoute, assertSameOrigin, sessionRoute } from '@/app/v1/_lib/v1-route';
import {
  PERMISSIONS,
  SYSTEM_GRANTOR,
  addMember,
  createApiKey,
  createTenant,
  handleDevSignIn,
  landingPathFor,
  setPrincipalCacheTtl,
} from '@/modules/tenancy';
import { assignment } from '@/modules/routing/db/schema';
import { membership, session, user } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';

const ORIGIN = 'http://localhost:4240';

async function signedIn(userId: string): Promise<Headers> {
  const res = await handleDevSignIn(
    new Request(`${ORIGIN}/api/dev/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    }),
    { enabled: true },
  );
  expect(res.status).toBe(200);
  return new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ') });
}

type Person = Awaited<ReturnType<typeof seedUser>>;
let admin: Person;
let owner: Person;
let operator: Person;
let seller: Person;
let alpha: { tenantId: string; slug: string };
let beta: { tenantId: string; slug: string };
const cookies: Record<string, Headers> = {};

async function tenantOwnedBy(by: Person, name: string, ownerEmail: string) {
  const slug = uniqueSlug();
  const t = await createTenant(by.actor, { slug, name, currency: 'EUR', timezone: 'Europe/Berlin', ownerEmail });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  return { tenantId: t.tenantId, slug };
}

beforeAll(async () => {
  admin = await seedUser({ admin: true, signedIn: true });
  owner = await seedUser({ signedIn: true });
  operator = await seedUser({ signedIn: true });
  seller = await seedUser({ signedIn: true });
  alpha = await tenantOwnedBy(admin, 'Alpha Co', owner.email);
  beta = await tenantOwnedBy(admin, 'Beta Co', seller.email);
  await inTenant(alpha.tenantId, owner.actor, async (ctx) => {
    await addMember(ctx, { email: operator.email, role: 'operator' });
    await addMember(ctx, { email: seller.email, role: 'seller' });
  });
  for (const p of [admin, owner, operator, seller]) cookies[p.id] = await signedIn(p.id);
});
beforeEach(() => setPrincipalCacheTtl(0));

const req = (path: string, opts: { as?: Person; tenant?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const h = new Headers(opts.as ? cookies[opts.as.id] : undefined);
  if (opts.tenant) h.set('x-scout-tenant', opts.tenant);
  if (opts.method && opts.method !== 'GET') h.set('origin', ORIGIN);
  if (opts.body !== undefined) h.set('content-type', 'application/json');
  for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, v);
  return new Request(`${ORIGIN}/v1${path}`, {
    method: opts.method ?? 'GET',
    headers: h,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
};

const apiKey = async (scopes: string[] = []) =>
  (
    await inTenant(alpha.tenantId, owner.actor, (ctx) =>
      createApiKey(ctx, { name: 'k', environment: 'live', scopes: scopes as never }, SYSTEM_GRANTOR),
    )
  ).secret;

describe('GET /v1/me', () => {
  it('gives a member the person, the tenant with currency and timezone, and their workspaces', async () => {
    const res = await me(req('/me', { as: seller, tenant: alpha.slug }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      user: { id: seller.id, name: seller.email.split('@')[0], email: seller.email, platform_admin: false },
      tenant: { id: alpha.tenantId, slug: alpha.slug, name: 'Alpha Co', currency: 'EUR', timezone: 'Europe/Berlin' },
      kind: 'user',
      id: seller.id,
    });
    expect(body.scopes).toContain('assignments:respond');
    expect(body.scopes).not.toContain('review:act');
    expect(body.workspaces).toEqual([
      { id: alpha.tenantId, slug: alpha.slug, name: 'Alpha Co', role: 'seller', member_count: 3 },
      { id: beta.tenantId, slug: beta.slug, name: 'Beta Co', role: 'owner', member_count: 1 },
    ]);
  });

  it('lands on the last used workspace when no tenant is named', async () => {
    const body = await (await me(req('/me', { as: owner }))).json();
    expect(body.tenant.slug).toBe(alpha.slug);
    expect(body.workspaces).toEqual([{ id: alpha.tenantId, slug: alpha.slug, name: 'Alpha Co', role: 'owner', member_count: 3 }]);
  });

  it('gives a platform admin with no membership tenant null and every active tenant, with no tenant named', async () => {
    const res = await me(req('/me', { as: admin }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      user: { id: admin.id, email: admin.email, platform_admin: true },
      tenant: null,
      kind: 'user',
      id: admin.id,
      scopes: [],
      data_limit: null,
    });
    expect(body.workspaces).toEqual(
      expect.arrayContaining([
        { id: alpha.tenantId, slug: alpha.slug, name: 'Alpha Co', role: null, member_count: 3 },
        { id: beta.tenantId, slug: beta.slug, name: 'Beta Co', role: null, member_count: 1 },
      ]),
    );
  });

  it('gives a platform admin in a tenant every permission', async () => {
    const body = await (await me(req('/me', { as: admin, tenant: alpha.slug }))).json();
    expect(body.tenant.slug).toBe(alpha.slug);
    expect([...body.scopes].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('a person with no workspace gets tenant null; nobody signed in gets 401', async () => {
    const loner = await seedUser({ signedIn: true });
    await inTenant(alpha.tenantId, owner.actor, (ctx) => addMember(ctx, { email: loner.email, role: 'seller' }));
    const h = await signedIn(loner.id);
    await adminDb.update(membership).set({ status: 'removed' }).where(eq(membership.userId, loner.id));
    const body = await (await me(new Request(`${ORIGIN}/v1/me`, { headers: h }))).json();
    expect(body).toMatchObject({ user: { id: loner.id, platform_admin: false }, tenant: null, workspaces: [], scopes: [] });
    expect((await me(req('/me'))).status).toBe(401);
  });

  it('an API key gets user null and no workspaces', async () => {
    const body = await (await me(req('/me', { headers: { authorization: `Bearer ${await apiKey()}` } }))).json();
    expect(body).toMatchObject({ user: null, workspaces: [], kind: 'api_key', tenant: { slug: alpha.slug } });
  });
});

describe('sessionRoute and adminRoute', () => {
  const echo = sessionRoute({}, async (_req, person, ctx) => ({ userId: person.userId, actor: ctx.actor }));
  const adminOnly = adminRoute({}, async (_req, person) => ({ admin: person.userId }));

  it('needs a signed-in person, not a key, and no tenant', async () => {
    const ok = await echo(req('/x', { as: seller }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-correlation-id')).toMatch(/^cor_/);
    expect(await ok.json()).toEqual({ user_id: seller.id, actor: { kind: 'user', id: seller.id } });
    expect((await echo(req('/x'))).status).toBe(401);
    const key = await echo(req('/x', { headers: { authorization: `Bearer ${await apiKey()}` } }));
    expect(key.status).toBe(403);
    expect(key.headers.get('content-type')).toContain('application/problem+json');
  });

  it('applies the 12 hour idle rule', async () => {
    const p = await seedUser({ signedIn: true });
    await inTenant(alpha.tenantId, owner.actor, (ctx) => addMember(ctx, { email: p.email, role: 'seller' }));
    const h = await signedIn(p.id);
    await adminDb.update(session).set({ updatedAt: new Date(Date.now() - 13 * 3600_000) }).where(eq(session.userId, p.id));
    expect((await echo(new Request(`${ORIGIN}/v1/x`, { headers: h }))).status).toBe(401);
  });

  it('applies the 7 day age rule, even to a session active a moment ago', async () => {
    const p = await seedUser({ signedIn: true });
    await inTenant(alpha.tenantId, owner.actor, (ctx) => addMember(ctx, { email: p.email, role: 'seller' }));
    const h = await signedIn(p.id);
    expect((await echo(new Request(`${ORIGIN}/v1/x`, { headers: h }))).status).toBe(200);
    await adminDb
      .update(session)
      .set({ createdAt: new Date(Date.now() - 8 * 86_400_000), updatedAt: new Date() })
      .where(eq(session.userId, p.id));
    expect((await echo(new Request(`${ORIGIN}/v1/x`, { headers: h }))).status).toBe(401);
  });

  it('refuses a disabled person and a disabled platform admin with a valid session', async () => {
    const p = await seedUser({ signedIn: true });
    const a = await seedUser({ admin: true, signedIn: true });
    await inTenant(alpha.tenantId, owner.actor, (ctx) => addMember(ctx, { email: p.email, role: 'seller' }));
    const hp = await signedIn(p.id);
    const ha = await signedIn(a.id);
    expect((await echo(new Request(`${ORIGIN}/v1/x`, { headers: hp }))).status).toBe(200);
    expect((await adminOnly(new Request(`${ORIGIN}/v1/admin/x`, { headers: ha }))).status).toBe(200);
    await adminDb.update(user).set({ disabledAt: new Date() }).where(inArray(user.id, [p.id, a.id]));
    for (const h of [hp, ha]) {
      expect((await echo(new Request(`${ORIGIN}/v1/x`, { headers: h }))).status).toBe(401);
      expect((await me(new Request(`${ORIGIN}/v1/me`, { headers: h }))).status).toBe(401);
    }
    expect((await adminOnly(new Request(`${ORIGIN}/v1/admin/x`, { headers: ha }))).status).toBe(401);
  });

  it('refuses a cross-site write before recording activity on the session', async () => {
    const p = await seedUser({ admin: true, signedIn: true });
    const h = await signedIn(p.id);
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    await adminDb.update(session).set({ updatedAt: twoHoursAgo }).where(eq(session.userId, p.id));
    const write = sessionRoute({}, async () => ({ ok: true }));
    const evil = new Headers(h);
    evil.set('origin', 'https://evil.example');
    evil.set('content-type', 'application/json');
    const res = await write(new Request(`${ORIGIN}/v1/x`, { method: 'POST', headers: evil, body: '{}' }));
    expect(res.status).toBe(403);
    const [s] = await adminDb.select({ updatedAt: session.updatedAt }).from(session).where(eq(session.userId, p.id));
    expect(s!.updatedAt.getTime()).toBe(twoHoursAgo.getTime());
    const adminWrite = adminRoute({}, async () => ({ ok: true }));
    expect((await adminWrite(new Request(`${ORIGIN}/v1/admin/x`, { method: 'POST', headers: evil, body: '{}' }))).status).toBe(403);
    const [s2] = await adminDb.select({ updatedAt: session.updatedAt }).from(session).where(eq(session.userId, p.id));
    expect(s2!.updatedAt.getTime()).toBe(twoHoursAgo.getTime());
  });

  it('adminRoute admits a platform admin with no tenant and refuses everyone else', async () => {
    const ok = await adminOnly(req('/admin/x', { as: admin }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ admin: admin.id });
    for (const p of [owner, seller]) expect((await adminOnly(req('/admin/x', { as: p }))).status).toBe(403);
    expect((await adminOnly(req('/admin/x'))).status).toBe(401);
    expect((await adminOnly(req('/admin/x', { headers: { authorization: `Bearer ${await apiKey()}` } }))).status).toBe(403);
  });

  it('cookie writes without x-scout-tenant pass from our origin; cross-site writes are refused', async () => {
    const write = adminRoute({}, async () => ({ ok: true }));
    expect((await write(req('/admin/x', { as: admin, method: 'POST', body: {} }))).status).toBe(200);
    const evil = await write(req('/admin/x', { as: admin, method: 'POST', body: {}, headers: { origin: 'https://evil.example' } }));
    expect(evil.status).toBe(403);
    expect((await evil.json()).type).toMatch(/\/csrf$/);
    const h = new Headers(cookies[admin.id]);
    h.set('content-type', 'application/json');
    expect((await write(new Request(`${ORIGIN}/v1/admin/x`, { method: 'POST', headers: h, body: '{}' }))).status).toBe(403);
  });

  it('a POST with an Idempotency-Key runs once', async () => {
    let runs = 0;
    const once = sessionRoute({}, async () => ({ run: ++runs }));
    const key = { 'idempotency-key': newId('cor') };
    const first = await once(req('/x', { as: owner, method: 'POST', body: { a: 1 }, headers: key }));
    const again = await once(req('/x', { as: owner, method: 'POST', body: { a: 1 }, headers: key }));
    expect(await first.json()).toEqual({ run: 1 });
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(await again.json()).toEqual({ run: 1 });
    const other = await once(req('/x', { as: owner, method: 'POST', body: { a: 2 }, headers: key }));
    expect(other.status).toBe(409);
  });

  it('assertSameOrigin checks only the origin', () => {
    const post = (h: Record<string, string>, method = 'POST') => new Request(`${ORIGIN}/v1/y`, { method, headers: h });
    expect(() => assertSameOrigin(post({ origin: ORIGIN }))).not.toThrow();
    expect(() => assertSameOrigin(post({}, 'GET'))).not.toThrow();
    expect(() => assertSameOrigin(post({}))).toThrow(expect.objectContaining({ slug: 'csrf', status: 403 }));
    expect(() => assertSameOrigin(post({ origin: 'https://evil.example' }))).toThrow(expect.objectContaining({ slug: 'csrf' }));
  });
});

describe('PUT /v1/me/workspace', () => {
  it('writes the last used workspace, so /me and sign-in land there', async () => {
    const res = await putWorkspace(req('/me/workspace', { as: seller, method: 'PUT', body: { slug: beta.slug } }));
    expect(res.status).toBe(204);
    const [u] = await adminDb.select({ last: user.lastTenantId }).from(user).where(eq(user.id, seller.id));
    expect(u!.last).toBe(beta.tenantId);
    expect(await landingPathFor(seller.id)).toBe(`/t/${beta.slug}`);
    expect((await (await me(req('/me', { as: seller }))).json()).tenant.slug).toBe(beta.slug);
  });

  it('lets a platform admin pick any active tenant and lands them there', async () => {
    expect((await putWorkspace(req('/me/workspace', { as: admin, method: 'PUT', body: { slug: alpha.slug } }))).status).toBe(204);
    expect(await landingPathFor(admin.id)).toBe(`/t/${alpha.slug}`);
    expect((await (await me(req('/me', { as: admin }))).json()).tenant.slug).toBe(alpha.slug);
    await adminDb.update(user).set({ lastTenantId: null }).where(eq(user.id, admin.id));
  });

  it('404 for a workspace the person is not a member of', async () => {
    const res = await putWorkspace(req('/me/workspace', { as: operator, method: 'PUT', body: { slug: beta.slug } }));
    expect(res.status).toBe(404);
    expect((await res.json()).type).toMatch(/\/not-found$/);
  });

  it('400 without a slug; 403 for an API key; 403 cross-site', async () => {
    const bad = await putWorkspace(req('/me/workspace', { as: seller, method: 'PUT', body: {} }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).type).toMatch(/\/validation$/);
    const key = await putWorkspace(
      req('/me/workspace', { method: 'PUT', body: { slug: alpha.slug }, headers: { authorization: `Bearer ${await apiKey()}` } }),
    );
    expect(key.status).toBe(403);
    const evil = await putWorkspace(
      req('/me/workspace', { as: seller, method: 'PUT', body: { slug: alpha.slug }, headers: { origin: 'https://evil.example' } }),
    );
    expect(evil.status).toBe(403);
  });
});

describe('GET /v1/me/counts', () => {
  it('counts the review queue for review:act and new assignments for assignments:respond', async () => {
    await adminDb.insert(assignment).values({
      id: newId('asg'),
      tenantId: alpha.tenantId,
      accountId: newId('acc'),
      sellerUserId: seller.id,
      assignedBy: owner.id,
    });
    const s = await counts(req('/me/counts', { as: seller, tenant: alpha.slug }));
    expect(s.status).toBe(200);
    expect(await s.json()).toEqual({ review_queue: null, new_assignments: 1 });
    const o = await (await counts(req('/me/counts', { as: operator, tenant: alpha.slug }))).json();
    expect(o).toEqual({ review_queue: 0, new_assignments: null });
    const own = await (await counts(req('/me/counts', { as: owner, tenant: alpha.slug }))).json();
    expect(own).toEqual({ review_queue: 0, new_assignments: 0 });
    const done = await adminDb
      .update(assignment)
      .set({ status: 'accepted' })
      .where(and(eq(assignment.tenantId, alpha.tenantId), eq(assignment.sellerUserId, seller.id)))
      .returning();
    expect(done).toHaveLength(1);
    expect((await (await counts(req('/me/counts', { as: seller, tenant: alpha.slug }))).json()).new_assignments).toBe(0);
  });

  it('refuses API keys', async () => {
    const res = await counts(req('/me/counts', { headers: { authorization: `Bearer ${await apiKey(['review:act'])}` } }));
    expect(res.status).toBe(403);
  });
});
