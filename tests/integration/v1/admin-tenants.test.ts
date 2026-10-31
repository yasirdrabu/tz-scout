import { and, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as listTenantsRoute, POST as createTenantRoute } from '@/app/v1/admin/tenants/route';
import { POST as tenantAction } from '@/app/v1/admin/tenants/[id]/route';
import { GET as listAdmins, POST as addAdmin } from '@/app/v1/admin/platform-admins/route';
import { DELETE as removeAdmin } from '@/app/v1/admin/platform-admins/[id]/route';
import { GET as me } from '@/app/v1/me/route';
import { SYSTEM_GRANTOR, checkSignIn, createApiKey, setPrincipalCacheTtl } from '@/modules/tenancy';
import { membership, user } from '@/modules/tenancy/db/schema';
import { auditLog } from '@/platform/db/schema';
import { adminDb } from '@/platform/db/client';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';
import { signedIn, tenantOwnedBy, v1Req, type Person } from './session-helpers';

let admin: Person;
let owner: Person;
let acme: { tenantId: string; slug: string };
const cookies: Record<string, Headers> = {};
let keySecret: string;

beforeAll(async () => {
  admin = await seedUser({ admin: true, signedIn: true });
  owner = await seedUser({ signedIn: true });
  acme = await tenantOwnedBy(admin, owner.email, 'Acme Admin Test');
  for (const p of [admin, owner]) cookies[p.id] = await signedIn(p.id);
  keySecret = (
    await inTenant(acme.tenantId, owner.actor, (ctx) =>
      createApiKey(ctx, { name: 'k', environment: 'live', scopes: ['accounts:read'] }, SYSTEM_GRANTOR),
    )
  ).secret;
});
beforeEach(() => setPrincipalCacheTtl(0));

const as = (p: Person) => ({ cookies: cookies[p.id] });
const bearer = () => ({ headers: { authorization: `Bearer ${keySecret}` } });

/** The owner of a tenant, an API key and nobody signed in are all refused. */
async function refusesNonAdmins(call: (opts: Parameters<typeof v1Req>[1]) => Promise<Response>, extra: Parameters<typeof v1Req>[1] = {}) {
  expect((await call({ ...extra, ...as(owner) })).status).toBe(403);
  expect((await call({ ...extra, ...bearer() })).status).toBe(403);
  expect((await call({ ...extra })).status).toBe(401);
}

describe('GET /v1/admin/tenants', () => {
  it('lists every tenant with status, members, owner and created, plus the summary', async () => {
    const res = await listTenantsRoute(v1Req('/admin/tenants', as(admin)));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data.find((t: { id: string }) => t.id === acme.tenantId);
    expect(row).toMatchObject({
      slug: acme.slug,
      name: 'Acme Admin Test',
      status: 'active',
      currency: 'EUR',
      timezone: 'Europe/Berlin',
      member_count: 1,
      owner: { email: owner.email },
    });
    expect(Date.parse(row.created_at)).not.toBeNaN();
    expect(body.summary.active).toBeGreaterThanOrEqual(1);
    expect(typeof body.summary.suspended).toBe('number');
    expect(body.summary.total).toBe(body.data.length);
  });

  it('refuses a tenant owner, an API key and anonymous callers', async () => {
    await refusesNonAdmins((o) => listTenantsRoute(v1Req('/admin/tenants', o)));
  });
});

describe('POST /v1/admin/tenants', () => {
  it('creates the tenant with its owner invited, and audits it', async () => {
    const slug = uniqueSlug();
    const email = `own-${slug}@example.com`;
    const res = await createTenantRoute(
      v1Req('/admin/tenants', { ...as(admin), method: 'POST', body: { name: 'Globex', slug, owner_email: email, currency: 'gbp', timezone: 'Europe/London' } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ slug, name: 'Globex', status: 'active', currency: 'GBP', timezone: 'Europe/London', member_count: 1, owner: { email } });
    const [m] = await adminDb.select().from(membership).where(eq(membership.tenantId, body.id));
    expect(m).toMatchObject({ role: 'owner', status: 'invited' });
    const [a] = await adminDb.select().from(auditLog).where(and(eq(auditLog.action, 'tenancy.tenant.created'), eq(auditLog.subjectId, body.id)));
    expect(a).toMatchObject({ tenantId: 't_platform', actorId: admin.id });
  });

  it('defaults currency and timezone as the old form did', async () => {
    const slug = uniqueSlug();
    const res = await createTenantRoute(
      v1Req('/admin/tenants', { ...as(admin), method: 'POST', body: { name: 'Initech', slug, owner_email: `o-${slug}@example.com` } }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ currency: 'USD', timezone: 'America/New_York' });
  });

  it('gives 400 for a bad slug, email, timezone or unknown field, and 409 for a taken slug', async () => {
    const post = (body: object) => createTenantRoute(v1Req('/admin/tenants', { ...as(admin), method: 'POST', body }));
    const ok = { name: 'X', slug: uniqueSlug(), owner_email: 'x@example.com' };
    const bad = await post({ ...ok, slug: '-Bad-' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).type).toMatch(/\/validation$/);
    expect((await post({ ...ok, owner_email: 'nope' })).status).toBe(400);
    expect((await post({ ...ok, timezone: 'Mars/Base' })).status).toBe(400);
    expect((await post({ ...ok, start_with: 'copy' })).status).toBe(400);
    const taken = await post({ ...ok, slug: acme.slug });
    expect(taken.status).toBe(409);
    expect((await taken.json()).type).toMatch(/\/slug-taken$/);
  });

  it('refuses non-admins and cross-site writes', async () => {
    const body = { name: 'X', slug: uniqueSlug(), owner_email: 'x@example.com' };
    await refusesNonAdmins((o) => createTenantRoute(v1Req('/admin/tenants', { ...o, method: 'POST', body })));
    const evil = await createTenantRoute(v1Req('/admin/tenants', { ...as(admin), method: 'POST', body, headers: { origin: 'https://evil.example' } }));
    expect(evil.status).toBe(403);
  });
});

describe('POST /v1/admin/tenants/{id}:suspend and :resume', () => {
  it('suspending stops sign-in, sessions and API keys; resuming brings them back', async () => {
    setPrincipalCacheTtl(60_000);
    const t = await tenantOwnedBy(admin, (await seedUser({ signedIn: true })).email, 'Suspendable');
    const [m] = await adminDb.select({ userId: membership.userId }).from(membership).where(eq(membership.tenantId, t.tenantId));
    const memberCookies = await signedIn(m!.userId);
    const key = (
      await inTenant(t.tenantId, admin.actor, (ctx) =>
        createApiKey(ctx, { name: 'k', environment: 'live', scopes: ['accounts:read'] }, SYSTEM_GRANTOR),
      )
    ).secret;
    // Warm the caches: the suspension must drop them.
    expect((await me(v1Req('/me', { cookies: memberCookies, tenant: t.slug }))).status).toBe(200);
    expect((await me(v1Req('/me', { headers: { authorization: `Bearer ${key}` } }))).status).toBe(200);

    const res = await tenantAction(v1Req(`/admin/tenants/${t.tenantId}:suspend`, { ...as(admin), method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: t.tenantId, status: 'suspended' });
    expect((await me(v1Req('/me', { cookies: memberCookies, tenant: t.slug }))).status).toBe(401);
    expect((await me(v1Req('/me', { headers: { authorization: `Bearer ${key}` } }))).status).toBe(401);
    expect((await checkSignIn({ userId: m!.userId })).ok).toBe(false);
    const [a] = await adminDb.select().from(auditLog).where(and(eq(auditLog.action, 'tenancy.tenant.suspended'), eq(auditLog.subjectId, t.tenantId)));
    expect(a).toMatchObject({ tenantId: 't_platform', actorId: admin.id, after: { status: 'suspended' } });

    const again = await tenantAction(v1Req(`/admin/tenants/${t.tenantId}:suspend`, { ...as(admin), method: 'POST' }));
    expect(again.status).toBe(409);

    const resumed = await tenantAction(v1Req(`/admin/tenants/${t.tenantId}:resume`, { ...as(admin), method: 'POST' }));
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ status: 'active' });
    expect((await me(v1Req('/me', { cookies: memberCookies, tenant: t.slug }))).status).toBe(200);
    expect((await me(v1Req('/me', { headers: { authorization: `Bearer ${key}` } }))).status).toBe(200);
    expect((await checkSignIn({ userId: m!.userId })).ok).toBe(true);
    expect((await tenantAction(v1Req(`/admin/tenants/${t.tenantId}:resume`, { ...as(admin), method: 'POST' }))).status).toBe(409);
  });

  it('gives 404 for an unknown tenant or action, and refuses non-admins', async () => {
    expect((await tenantAction(v1Req('/admin/tenants/t_nope:suspend', { ...as(admin), method: 'POST' }))).status).toBe(404);
    expect((await tenantAction(v1Req(`/admin/tenants/${acme.tenantId}:delete`, { ...as(admin), method: 'POST' }))).status).toBe(404);
    for (const action of ['suspend', 'resume']) {
      await refusesNonAdmins((o) => tenantAction(v1Req(`/admin/tenants/${acme.tenantId}:${action}`, { ...o, method: 'POST' })));
    }
  });
});

describe('/v1/admin/platform-admins', () => {
  it('lists platform admins who are not turned off', async () => {
    const res = await listAdmins(v1Req('/admin/platform-admins', as(admin)));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toContainEqual(expect.objectContaining({ user_id: admin.id, email: admin.email }));
    expect(data.find((a: { user_id: string }) => a.user_id === owner.id)).toBeUndefined();
  });

  it('adds an @taazaa.com person, creating them, and audits it; removes them again', async () => {
    const email = `staff-${uniqueSlug()}@Taazaa.com`;
    const res = await addAdmin(v1Req('/admin/platform-admins', { ...as(admin), method: 'POST', body: { email } }));
    expect(res.status).toBe(201);
    const added = await res.json();
    expect(added).toMatchObject({ email: email.toLowerCase(), last_sign_in_at: null });
    const [u] = await adminDb.select().from(user).where(eq(user.id, added.user_id));
    expect(u!.platformAdmin).toBe(true);
    const [a] = await adminDb.select().from(auditLog).where(and(eq(auditLog.action, 'tenancy.platform_admin.added'), eq(auditLog.subjectId, added.user_id)));
    expect(a).toMatchObject({ tenantId: 't_platform', actorId: admin.id });
    expect((await addAdmin(v1Req('/admin/platform-admins', { ...as(admin), method: 'POST', body: { email } }))).status).toBe(409);

    const del = await removeAdmin(v1Req(`/admin/platform-admins/${added.user_id}`, { ...as(admin), method: 'DELETE' }));
    expect(del.status).toBe(204);
    const [after] = await adminDb.select().from(user).where(eq(user.id, added.user_id));
    expect(after!.platformAdmin).toBe(false);
    const [r] = await adminDb.select().from(auditLog).where(and(eq(auditLog.action, 'tenancy.platform_admin.removed'), eq(auditLog.subjectId, added.user_id)));
    expect(r).toMatchObject({ actorId: admin.id });
    expect((await removeAdmin(v1Req(`/admin/platform-admins/${added.user_id}`, { ...as(admin), method: 'DELETE' }))).status).toBe(404);
  });

  it('a removed admin loses /admin at once', async () => {
    const other = await seedUser({ admin: true, signedIn: true });
    const h = await signedIn(other.id);
    expect((await listAdmins(v1Req('/admin/platform-admins', { cookies: h }))).status).toBe(200);
    expect((await removeAdmin(v1Req(`/admin/platform-admins/${other.id}`, { ...as(admin), method: 'DELETE' }))).status).toBe(204);
    expect((await listAdmins(v1Req('/admin/platform-admins', { cookies: h }))).status).toBe(403);
  });

  it('refuses an address outside @taazaa.com and a bad body', async () => {
    const bad = await addAdmin(v1Req('/admin/platform-admins', { ...as(admin), method: 'POST', body: { email: 'ana@example.com' } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).type).toMatch(/\/not-staff-email$/);
    expect((await addAdmin(v1Req('/admin/platform-admins', { ...as(admin), method: 'POST', body: {} }))).status).toBe(400);
  });

  it('nobody removes themselves', async () => {
    const res = await removeAdmin(v1Req(`/admin/platform-admins/${admin.id}`, { ...as(admin), method: 'DELETE' }));
    expect(res.status).toBe(403);
    expect((await res.json()).type).toMatch(/\/not-yourself$/);
  });

  it('refuses non-admins on every method', async () => {
    await refusesNonAdmins((o) => listAdmins(v1Req('/admin/platform-admins', o)));
    await refusesNonAdmins((o) => addAdmin(v1Req('/admin/platform-admins', { ...o, method: 'POST', body: { email: 'x@taazaa.com' } })));
    await refusesNonAdmins((o) => removeAdmin(v1Req(`/admin/platform-admins/${admin.id}`, { ...o, method: 'DELETE' })));
  });
});

describe('a turned-off platform admin', () => {
  it('gets 401 on admin reads and writes even with a valid session', async () => {
    const off = await seedUser({ admin: true, signedIn: true });
    const h = await signedIn(off.id);
    expect((await listTenantsRoute(v1Req('/admin/tenants', { cookies: h }))).status).toBe(200);
    await adminDb.update(user).set({ disabledAt: new Date() }).where(eq(user.id, off.id));
    expect((await listTenantsRoute(v1Req('/admin/tenants', { cookies: h }))).status).toBe(401);
    const slug = uniqueSlug();
    const res = await createTenantRoute(
      v1Req('/admin/tenants', { cookies: h, method: 'POST', body: { name: 'Should not exist', slug, owner_email: 'nobody@example.com' } }),
    );
    expect(res.status).toBe(401);
    expect((await adminDb.select().from(auditLog).where(and(eq(auditLog.action, 'tenancy.tenant.created'), eq(auditLog.actorId, off.id))))).toHaveLength(0);
  });
});
