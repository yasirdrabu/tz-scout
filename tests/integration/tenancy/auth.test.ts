import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as devSignInRoute } from '@/app/api/dev/sign-in/route';
import {
  NOT_SET_UP,
  addMember,
  auth,
  checkSignIn,
  createTenant,
  handleDevSignIn,
  landingPathFor,
  PERMISSIONS,
  sessionPrincipal,
  setPrincipalCacheTtl,
  signInEmailFor,
  tenantsFor,
} from '@/modules/tenancy';
import { createAuth } from '@/modules/tenancy/auth';
import { membership, session, tenant, user } from '@/modules/tenancy/db/schema';
import { config } from '@/platform/config';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { inTenant, seedUser, uniqueSlug } from './helpers';

const HOUR = 3600_000;

async function newTenant(ownerEmail?: string) {
  const admin = await seedUser({ admin: true });
  const o = ownerEmail ? { email: ownerEmail } : await seedUser({ signedIn: true });
  const slug = uniqueSlug();
  const t = await createTenant(admin.actor, { slug, name: `T ${slug}`, currency: 'USD', timezone: 'UTC', ownerEmail: o.email });
  const [m] = await adminDb.select().from(membership).where(eq(membership.id, t.ownerMembershipId));
  return { ...t, slug, admin, ownerUserId: m!.userId };
}

async function activate(membershipId: string) {
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, membershipId));
}

/** Signs in as `userId` through the developer sign-in and returns request headers carrying the cookie. */
async function signedIn(userId: string): Promise<Headers> {
  const res = await handleDevSignIn(
    new Request('http://localhost:4240/api/dev/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    }),
    { enabled: true },
  );
  expect(res.status).toBe(200);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
  expect(cookies.length).toBeGreaterThan(0);
  return new Headers({ cookie: cookies.join('; ') });
}

const sessionsOf = (userId: string) => adminDb.select().from(session).where(eq(session.userId, userId));

beforeAll(() => setPrincipalCacheTtl(0));
afterAll(() => setPrincipalCacheTtl(60_000));

describe('sign-in gate (TEN-E2-S1, Review Focus 5)', () => {
  let ashId: string;
  let tenantId: string;

  beforeAll(async () => {
    const t = await newTenant('ash@taazaa.com');
    ashId = t.ownerUserId;
    tenantId = t.tenantId;
  });

  it('accepts a member whose profile email differs only in case', async () => {
    expect(await checkSignIn({ email: 'Ash@Taazaa.com' })).toEqual({ ok: true, userId: ashId });
    expect(await signInEmailFor({ email: 'Ash@Taazaa.com', oid: 'o-1' })).toBe('ash@taazaa.com');
  });

  it('accepts a profile that has only the user principal name', async () => {
    expect(await checkSignIn({ upn: 'ash@taazaa.com' })).toEqual({ ok: true, userId: ashId });
    expect(await signInEmailFor({ preferred_username: 'ASH@taazaa.com', oid: 'o-2' })).toBe('ash@taazaa.com');
    expect(await signInEmailFor({ upn: 'ash@taazaa.com', oid: 'o-3' })).toBe('ash@taazaa.com');
  });

  it('matches by Entra object id before email', async () => {
    const other = await seedUser({ email: 'renamed@taazaa.com' });
    const t = await newTenant();
    await inTenant(t.tenantId, { kind: 'user', id: t.ownerUserId }, (ctx) =>
      addMember(ctx, { email: other.email, role: 'seller' }),
    );
    await adminDb.update(user).set({ entraObjectId: 'oid-renamed' }).where(eq(user.id, other.id));
    expect(await checkSignIn({ email: 'ash@taazaa.com', entraObjectId: 'oid-renamed' })).toEqual({
      ok: true,
      userId: other.id,
    });
    expect(await signInEmailFor({ email: 'old-name@taazaa.com', oid: 'oid-renamed' })).toBe('renamed@taazaa.com');
  });

  it('rejects someone who is not a member anywhere, with the exact message (TEN-E2-S1-AC2)', async () => {
    expect(NOT_SET_UP).toBe("Your account isn't set up in Scout yet. Ask your Scout owner to add you.");
    expect(await checkSignIn({ email: 'nobody@taazaa.com' })).toEqual({ ok: false, message: NOT_SET_UP });
    expect(await checkSignIn({})).toEqual({ ok: false, message: NOT_SET_UP });
  });

  it('creates no user and no session for a non-member', async () => {
    const ctx = await auth.$context;
    await expect(
      ctx.internalAdapter.createUser(
        { email: 'nobody@taazaa.com', name: 'Nobody' },
        { method: 'oauth', oauth: { providerId: 'microsoft' } },
      ),
    ).rejects.toThrow(NOT_SET_UP);
    expect(await adminDb.select().from(user).where(eq(user.email, 'nobody@taazaa.com'))).toHaveLength(0);

    // A user row without any membership (for example, everyone removed) is also refused a session.
    const loner = await seedUser({ email: 'loner@taazaa.com', signedIn: true });
    await expect(ctx.internalAdapter.createSession(loner.id)).rejects.toThrow(NOT_SET_UP);
    expect(await sessionsOf(loner.id)).toHaveLength(0);
  });

  it('an invited member becomes active on first sign-in (TEN-E2-S1-AC3)', async () => {
    const [before] = await adminDb.select().from(membership).where(eq(membership.userId, ashId));
    expect(before!.status).toBe('invited');
    const ctx = await auth.$context;
    const s = await ctx.internalAdapter.createSession(ashId);
    expect(s.id).toMatch(/^ses_/);
    const [after] = await adminDb.select().from(membership).where(eq(membership.userId, ashId));
    expect(after!.status).toBe('active');
    const [u] = await adminDb.select().from(user).where(eq(user.id, ashId));
    expect(u!.lastSignInAt).not.toBeNull();
    const rows = await adminDb
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, 'tenancy.member.activated')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorKind: 'user', actorId: ashId, subjectId: after!.id });
    // No new event: member.added was published at invite.
    const ev = await adminDb.execute(
      sql`select 1 from platform.outbox where tenant_id = ${tenantId} and payload->>'type' like 'tenancy.member.%'`,
    );
    expect(ev).toHaveLength(0);
  });

  it('a disabled user cannot sign in (TEN-E2-S3-AC1)', async () => {
    const t = await newTenant();
    await adminDb.update(user).set({ disabledAt: new Date() }).where(eq(user.id, t.ownerUserId));
    const r = await checkSignIn({ userId: t.ownerUserId });
    expect(r.ok).toBe(false);
    const ctx = await auth.$context;
    await expect(ctx.internalAdapter.createSession(t.ownerUserId)).rejects.toThrow();
    expect(await sessionsOf(t.ownerUserId)).toHaveLength(0);
  });

  it('memberships only in suspended tenants do not let anyone in', async () => {
    const t = await newTenant();
    await adminDb.update(tenant).set({ status: 'suspended' }).where(eq(tenant.id, t.tenantId));
    expect(await checkSignIn({ userId: t.ownerUserId })).toEqual({ ok: false, message: NOT_SET_UP });
  });

  it('platform admins may sign in without a membership', async () => {
    const admin = await seedUser({ admin: true });
    expect(await checkSignIn({ userId: admin.id })).toEqual({ ok: true, userId: admin.id });
  });
});

describe('sessionPrincipal (TEN-E1-S2-AC2, TEN-E2-S3-AC1)', () => {
  it('returns the member principal for a tenant they belong to, and null elsewhere', async () => {
    const t = await newTenant();
    await activate(t.ownerMembershipId);
    const other = await newTenant();
    const headers = await signedIn(t.ownerUserId);
    const p = await sessionPrincipal(headers, t.slug);
    expect(p).toMatchObject({
      tenantId: t.tenantId,
      kind: 'user',
      id: t.ownerUserId,
      userId: t.ownerUserId,
      platformAdmin: false,
      supportAccess: false,
      dataLimit: { kind: 'all' },
    });
    expect(p!.permissions).toEqual(expect.arrayContaining(['members:manage']));
    expect(await sessionPrincipal(headers, other.slug)).toBeNull();
    expect(await sessionPrincipal(headers, 'no-such-tenant')).toBeNull();
    expect(await sessionPrincipal(new Headers(), t.slug)).toBeNull();
  });

  it('uses the membership data limit, or the role default', async () => {
    const t = await newTenant();
    await activate(t.ownerMembershipId);
    const seller = await seedUser({ signedIn: true });
    const mid = await inTenant(t.tenantId, { kind: 'user', id: t.ownerUserId }, (ctx) =>
      addMember(ctx, { email: seller.email, role: 'seller' }),
    );
    const headers = await signedIn(seller.id);
    expect((await sessionPrincipal(headers, t.slug))!.dataLimit).toEqual({ kind: 'own_accounts' });
    await adminDb
      .update(membership)
      .set({ dataLimit: { kind: 'practices', ids: ['prc_1'] } })
      .where(eq(membership.id, mid));
    expect((await sessionPrincipal(headers, t.slug))!.dataLimit).toEqual({ kind: 'practices', ids: ['prc_1'] });
  });

  it('a user disabled 5 seconds ago gets null after the cache window', async () => {
    const t = await newTenant();
    await activate(t.ownerMembershipId);
    const headers = await signedIn(t.ownerUserId);
    expect(await sessionPrincipal(headers, t.slug)).not.toBeNull();
    await adminDb
      .update(user)
      .set({ disabledAt: new Date(Date.now() - 5000) })
      .where(eq(user.id, t.ownerUserId));
    expect(await sessionPrincipal(headers, t.slug)).toBeNull();
  });

  it('caches membership lookups for the cache window', async () => {
    const t = await newTenant();
    await activate(t.ownerMembershipId);
    const headers = await signedIn(t.ownerUserId);
    setPrincipalCacheTtl(60_000);
    try {
      expect(await sessionPrincipal(headers, t.slug)).not.toBeNull();
      await adminDb.update(membership).set({ status: 'removed' }).where(eq(membership.id, t.ownerMembershipId));
      expect(await sessionPrincipal(headers, t.slug)).not.toBeNull(); // still cached
    } finally {
      setPrincipalCacheTtl(0);
    }
    expect(await sessionPrincipal(headers, t.slug)).toBeNull(); // removed member is out
  });

  it('a session last updated 13 hours ago returns null', async () => {
    const t = await newTenant();
    await activate(t.ownerMembershipId);
    const headers = await signedIn(t.ownerUserId);
    await adminDb
      .update(session)
      .set({ updatedAt: new Date(Date.now() - 13 * HOUR) })
      .where(eq(session.userId, t.ownerUserId));
    expect(await sessionPrincipal(headers, t.slug)).toBeNull();
  });

  it('a session idle 2 hours is kept and marked active again', async () => {
    const t = await newTenant();
    await activate(t.ownerMembershipId);
    const headers = await signedIn(t.ownerUserId);
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR);
    await adminDb.update(session).set({ updatedAt: twoHoursAgo }).where(eq(session.userId, t.ownerUserId));
    expect(await sessionPrincipal(headers, t.slug)).not.toBeNull();
    const [s] = await sessionsOf(t.ownerUserId);
    expect(s!.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('a session older than 7 days returns null, however active', async () => {
    const t = await newTenant();
    await activate(t.ownerMembershipId);
    const headers = await signedIn(t.ownerUserId);
    await adminDb
      .update(session)
      .set({ createdAt: new Date(Date.now() - 7 * 24 * HOUR - 60_000) })
      .where(eq(session.userId, t.ownerUserId));
    expect(await sessionPrincipal(headers, t.slug)).toBeNull();
  });

  it('a suspended tenant returns null, even for its owner', async () => {
    const t = await newTenant();
    await activate(t.ownerMembershipId);
    const headers = await signedIn(t.ownerUserId);
    await adminDb.update(tenant).set({ status: 'suspended' }).where(eq(tenant.id, t.tenantId));
    expect(await sessionPrincipal(headers, t.slug)).toBeNull();
  });

  it('platform admins get any active tenant with support access and every permission', async () => {
    const t = await newTenant();
    const admin = await seedUser({ admin: true });
    const headers = await signedIn(admin.id);
    const p = await sessionPrincipal(headers, t.slug);
    expect(p).toMatchObject({ tenantId: t.tenantId, platformAdmin: true, supportAccess: true, userId: admin.id });
    expect([...p!.permissions].sort()).toEqual([...PERMISSIONS].sort());
    await adminDb.update(tenant).set({ status: 'suspended' }).where(eq(tenant.id, t.tenantId));
    expect(await sessionPrincipal(headers, t.slug)).toBeNull();
  });
});

describe('landingPathFor (TEN-E2-S1-AC1)', () => {
  it('lands on the last used tenant, else the first active tenant', async () => {
    const p = await seedUser({ signedIn: true });
    const a = await newTenant();
    const b = await newTenant();
    for (const t of [a, b]) {
      await inTenant(t.tenantId, { kind: 'user', id: t.ownerUserId }, (ctx) =>
        addMember(ctx, { email: p.email, role: 'seller' }),
      );
    }
    const first = (await tenantsFor(p.id))[0]!;
    expect(await landingPathFor(p.id)).toBe(`/t/${first.slug}`);
    const last = first.id === a.tenantId ? b : a;
    await adminDb.update(user).set({ lastTenantId: last.tenantId }).where(eq(user.id, p.id));
    expect(await landingPathFor(p.id)).toBe(`/t/${last.slug}`);
    await adminDb.update(tenant).set({ status: 'suspended' }).where(eq(tenant.id, last.tenantId));
    expect(await landingPathFor(p.id)).toBe(`/t/${first.slug}`);
  });
});

describe('tenantsFor and createTenant fixes', () => {
  it('tenantsFor skips suspended tenants and returns nothing for a disabled user', async () => {
    const t1 = await newTenant();
    const t2 = await newTenant();
    const p = await seedUser({ signedIn: true });
    for (const t of [t1, t2]) {
      await inTenant(t.tenantId, { kind: 'user', id: t.ownerUserId }, (ctx) =>
        addMember(ctx, { email: p.email, role: 'seller' }),
      );
    }
    expect((await tenantsFor(p.id)).map((t) => t.id).sort()).toEqual([t1.tenantId, t2.tenantId].sort());
    await adminDb.update(tenant).set({ status: 'suspended' }).where(eq(tenant.id, t1.tenantId));
    expect((await tenantsFor(p.id)).map((t) => t.id)).toEqual([t2.tenantId]);
    await adminDb.update(user).set({ disabledAt: new Date() }).where(eq(user.id, p.id));
    expect(await tenantsFor(p.id)).toEqual([]);
  });

  it('createTenant refuses a disabled platform admin', async () => {
    const admin = await seedUser({ admin: true });
    await adminDb.update(user).set({ disabledAt: new Date() }).where(eq(user.id, admin.id));
    await expect(
      createTenant(admin.actor, {
        slug: uniqueSlug(),
        name: 'X',
        currency: 'USD',
        timezone: 'UTC',
        ownerEmail: 'x@example.com',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('developer sign-in (TEN-E2-S2)', () => {
  it('returns 404 when AUTH_DEV_SIGNIN is off', async () => {
    expect(config.authDevSignin).toBe(false);
    const p = await seedUser({ signedIn: true });
    const res = await devSignInRoute(
      new Request('http://localhost:4240/api/dev/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: p.id }),
      }),
    );
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await sessionsOf(p.id)).toHaveLength(0);
  });

  it('when on, signs in a member and still applies the gate', async () => {
    const t = await newTenant();
    await activate(t.ownerMembershipId);
    const headers = await signedIn(t.ownerUserId);
    const s = await auth.api.getSession({ headers });
    expect(s?.user.id).toBe(t.ownerUserId);

    const loner = await seedUser({ signedIn: true });
    const res = await handleDevSignIn(
      new Request('http://localhost:4240/api/dev/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: loner.id }),
      }),
      { enabled: true },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ title: NOT_SET_UP });
    expect(await sessionsOf(loner.id)).toHaveLength(0);
  });
});

describe('Microsoft callback through better-auth (fake Microsoft)', () => {
  const app = createAuth({ azureAd: { tenantId: 'tid-test', clientId: 'cid-test', clientSecret: 'secret-test' } });
  const realFetch = globalThis.fetch;
  let claims: Record<string, unknown> = {};

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  beforeAll(() => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/oauth2/v2.0/token')) {
        const idToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ tid: 'tid-test', ...claims })}.`;
        return Response.json({ access_token: 'at', id_token: idToken, token_type: 'Bearer', expires_in: 3600 });
      }
      return realFetch(input, init);
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  /** Runs sign-in and the callback; returns the redirect location and the cookies set. */
  async function signInWith(profile: Record<string, unknown>) {
    claims = profile;
    const { headers, response } = await app.api.signInSocial({
      body: { provider: 'microsoft', callbackURL: '/welcome', errorCallbackURL: '/sign-in' },
      returnHeaders: true,
    });
    const authUrl = new URL(response.url!);
    expect(authUrl.searchParams.get('scope')).toBe('openid profile email User.Read');
    const state = authUrl.searchParams.get('state')!;
    const cookie = headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .join('; ');
    const res = await app.handler(
      new Request(`${config.publicUrl}/api/auth/callback/microsoft?code=c1&state=${encodeURIComponent(state)}`, {
        headers: { cookie },
      }),
    );
    return { location: res.headers.get('location') ?? '', setCookie: res.headers.getSetCookie() };
  }

  it('links an invited member signing in with a differently cased email and activates them', async () => {
    const t = await newTenant('kim@taazaa.com');
    const r = await signInWith({ oid: 'oid-kim', email: 'Kim@Taazaa.com', name: 'Kim' });
    expect(r.location).toBe('/welcome');
    expect(r.setCookie.some((c) => c.includes('session_token='))).toBe(true);
    expect(await sessionsOf(t.ownerUserId)).toHaveLength(1);
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, t.ownerMembershipId));
    expect(m!.status).toBe('active');
    const [u] = await adminDb.select().from(user).where(eq(user.id, t.ownerUserId));
    expect(u).toMatchObject({ email: 'kim@taazaa.com', entraObjectId: 'oid-kim' });
  });

  it('accepts a profile with only the user principal name', async () => {
    const t = await newTenant('lee@taazaa.com');
    const r = await signInWith({ oid: 'oid-lee', preferred_username: 'Lee@Taazaa.com' });
    expect(r.location).toBe('/welcome');
    expect(await sessionsOf(t.ownerUserId)).toHaveLength(1);
  });

  it('refuses a non-member with the message and creates no user or session', async () => {
    const r = await signInWith({ oid: 'oid-nobody', email: 'nobody2@taazaa.com' });
    const loc = new URL(r.location, config.publicUrl);
    expect(loc.pathname).toBe('/sign-in');
    expect(loc.searchParams.get('error')).toBe('not_set_up');
    expect(loc.searchParams.get('error_description')).toBe(NOT_SET_UP);
    expect(r.setCookie.some((c) => /session_token=[^;]/.test(c))).toBe(false);
    expect(await adminDb.select().from(user).where(eq(user.email, 'nobody2@taazaa.com'))).toHaveLength(0);
  });
});

describe('Microsoft identity pinning', () => {
  const app = createAuth({ azureAd: { tenantId: 'tid-test', clientId: 'cid-test', clientSecret: 'secret-test' } });
  const realFetch = globalThis.fetch;
  let claims: Record<string, unknown> = {};
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  beforeAll(() => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/oauth2/v2.0/token')) {
        const idToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ tid: 'tid-other', ...claims })}.`;
        return Response.json({ access_token: 'at', id_token: idToken, token_type: 'Bearer', expires_in: 3600 });
      }
      return realFetch(input, init);
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  it('refuses a second Microsoft identity that claims the email of a member who already signed in', async () => {
    const t = await newTenant('pat@taazaa.com');
    await activate(t.ownerMembershipId);
    await adminDb.update(user).set({ entraObjectId: 'oid-pat' }).where(eq(user.id, t.ownerUserId));
    claims = { oid: 'oid-impostor', email: 'pat@taazaa.com' };
    const { headers, response } = await app.api.signInSocial({
      body: { provider: 'microsoft', callbackURL: '/welcome', errorCallbackURL: '/sign-in' },
      returnHeaders: true,
    });
    const state = new URL(response.url!).searchParams.get('state')!;
    const cookie = headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .join('; ');
    const res = await app.handler(
      new Request(`${config.publicUrl}/api/auth/callback/microsoft?code=c1&state=${encodeURIComponent(state)}`, {
        headers: { cookie },
      }),
    );
    const loc = new URL(res.headers.get('location') ?? '', config.publicUrl);
    expect(loc.searchParams.get('error')).toBe('not_set_up');
    expect(await sessionsOf(t.ownerUserId)).toHaveLength(0);
  });
});
