import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as devSignInRoute } from '@/http/routes/api/dev/sign-in/route';
import {
  NOT_SET_UP,
  SIGN_IN_FAILED,
  addMember,
  authHandler,
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
import { account, membership, session, tenant, user } from '@/modules/tenancy/db/schema';
import { config } from '@/platform/config';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { inTenant, seedUser, uniqueSlug } from './helpers';

const HOUR = 3600_000;
const POLICY = { homeTenantId: 'tid-home', allowedTenantIds: ['tid-home', 'tid-client'] };

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
    expect(await signInEmailFor({ email: 'Ash@Taazaa.com', oid: 'o-1', tid: 'tid-home' }, POLICY)).toBe('ash@taazaa.com');
  });

  it('accepts a profile that has only the user principal name', async () => {
    expect(await checkSignIn({ upn: 'ash@taazaa.com' })).toEqual({ ok: true, userId: ashId });
    expect(await signInEmailFor({ preferred_username: 'ASH@taazaa.com', oid: 'o-2', tid: 'tid-home' }, POLICY)).toBe('ash@taazaa.com');
    expect(await signInEmailFor({ upn: 'ash@taazaa.com', oid: 'o-3', tid: 'tid-home' }, POLICY)).toBe('ash@taazaa.com');
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
    expect(await signInEmailFor({ email: 'old-name@taazaa.com', oid: 'oid-renamed', tid: 'tid-home' }, POLICY)).toBe('renamed@taazaa.com');
  });

  it('matches by email only from a trusted Entra tenant, and pinned users only by their own identity', async () => {
    const nothing = /@sign-in\.invalid$/;
    expect(await signInEmailFor({ email: 'ash@taazaa.com', oid: 'o-4', tid: 'tid-client' }, POLICY)).toBe(
      'ash@taazaa.com',
    );
    expect(await signInEmailFor({ email: 'ash@taazaa.com', oid: 'o-5', tid: 'tid-evil' }, POLICY)).toMatch(nothing);
    expect(await signInEmailFor({ email: 'ash@taazaa.com', oid: 'o-6' }, POLICY)).toMatch(nothing);
    const pinned = await seedUser({ email: 'pinned@taazaa.com' });
    await adminDb
      .update(user)
      .set({ entraObjectId: 'oid-pinned', entraTenantId: 'tid-home' })
      .where(eq(user.id, pinned.id));
    expect(await signInEmailFor({ email: 'x@y.z', oid: 'oid-pinned', tid: 'tid-home' }, POLICY)).toBe(
      'pinned@taazaa.com',
    );
    expect(await signInEmailFor({ email: 'pinned@taazaa.com', oid: 'oid-pinned', tid: 'tid-evil' }, POLICY)).toMatch(
      nothing,
    );
    expect(await signInEmailFor({ email: 'pinned@taazaa.com', oid: 'oid-other', tid: 'tid-home' }, POLICY)).toMatch(
      nothing,
    );
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
  const app = createAuth({
    azureAd: {
      tenantId: 'tid-home',
      clientId: 'cid-test',
      clientSecret: 'secret-test',
      allowedTenantIds: POLICY.allowedTenantIds,
    },
  });
  const realFetch = globalThis.fetch;
  let claims: Record<string, unknown> = {};

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  beforeAll(() => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/oauth2/v2.0/token')) {
        const idToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ tid: 'tid-home', ...claims })}.`;
        return Response.json({ access_token: 'at', id_token: idToken, token_type: 'Bearer', expires_in: 3600 });
      }
      return realFetch(input, init);
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  /** Runs sign-in and the callback; returns the redirect location, its error code and the cookies set. */
  async function signInWith(profile: Record<string, unknown>, urls: { callbackURL?: string; errorCallbackURL?: string } = {}) {
    claims = profile;
    const { headers, response } = await app.api.signInSocial({
      body: { provider: 'microsoft', callbackURL: '/welcome', errorCallbackURL: '/sign-in', ...urls },
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
    const location = res.headers.get('location') ?? '';
    const loc = new URL(location, config.publicUrl);
    return {
      location,
      error: loc.searchParams.get('error'),
      description: loc.searchParams.get('error_description'),
      setCookie: res.headers.getSetCookie(),
    };
  }

  const accountsWith = (oid: string) => adminDb.select().from(account).where(eq(account.accountId, oid));

  it('links an invited member signing in with a differently cased email, activates and pins them', async () => {
    const t = await newTenant('kim@taazaa.com');
    const r = await signInWith({ oid: 'oid-kim', email: 'Kim@Taazaa.com', name: 'Kim' });
    expect(r.location).toBe('/welcome');
    expect(r.setCookie.some((c) => c.includes('session_token='))).toBe(true);
    expect(await sessionsOf(t.ownerUserId)).toHaveLength(1);
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, t.ownerMembershipId));
    expect(m!.status).toBe('active');
    const [u] = await adminDb.select().from(user).where(eq(user.id, t.ownerUserId));
    expect(u).toMatchObject({ email: 'kim@taazaa.com', entraObjectId: 'oid-kim', entraTenantId: 'tid-home' });
  });

  it('accepts a profile with only the user principal name', async () => {
    const t = await newTenant('lee@taazaa.com');
    const r = await signInWith({ oid: 'oid-lee', preferred_username: 'Lee@Taazaa.com' });
    expect(r.location).toBe('/welcome');
    expect(await sessionsOf(t.ownerUserId)).toHaveLength(1);
  });

  it('a first sign-in from another allowed tenant works', async () => {
    const t = await newTenant('tobi@client.example');
    const r = await signInWith({ oid: 'oid-tobi', tid: 'tid-client', email: 'tobi@client.example' });
    expect(r.location).toBe('/welcome');
    expect(await sessionsOf(t.ownerUserId)).toHaveLength(1);
    const [u] = await adminDb.select().from(user).where(eq(user.id, t.ownerUserId));
    expect(u).toMatchObject({ entraObjectId: 'oid-tobi', entraTenantId: 'tid-client' });
  });

  it('refuses a non-member with the message and creates no user or session', async () => {
    const r = await signInWith({ oid: 'oid-nobody', email: 'nobody2@taazaa.com' });
    expect(r.location.startsWith(`${config.publicUrl}/signin?`)).toBe(true);
    expect(r.error).toBe('not_set_up');
    expect(r.description).toBe(NOT_SET_UP);
    expect(r.setCookie.some((c) => /session_token=[^;]/.test(c))).toBe(false);
    expect(await adminDb.select().from(user).where(eq(user.email, 'nobody2@taazaa.com'))).toHaveLength(0);
  });

  it('failures go to the app sign-in page with the error code and the validated return path', async () => {
    const nobody = { oid: 'oid-nobody3', email: 'nobody3@taazaa.com' };
    const r = await signInWith(nobody, { callbackURL: '/t/acme/queue?x=1', errorCallbackURL: 'https://evil.example/x' });
    const loc = new URL(r.location);
    expect(loc.origin + loc.pathname).toBe(`${config.publicUrl}/signin`);
    expect(loc.searchParams.get('return')).toBe('/t/acme/queue?x=1');
    expect(loc.searchParams.get('error')).toBe('not_set_up');
    for (const unsafe of ['//evil.example/x', 'https://evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'welcome']) {
      const u = new URL((await signInWith(nobody, { callbackURL: unsafe })).location);
      expect(u.origin + u.pathname).toBe(`${config.publicUrl}/signin`);
      expect(u.searchParams.get('return')).toBeNull();
      expect(u.searchParams.get('error')).toBe('not_set_up');
    }
  });

  it('an unsafe return path is replaced by the home page', async () => {
    await newTenant('ray@taazaa.com');
    expect((await signInWith({ oid: 'oid-ray', email: 'ray@taazaa.com' }, { callbackURL: '//evil.example/x' })).location).toBe('/');
  });

  it('refuses a foreign Entra tenant claiming the email of an unpinned member', async () => {
    const t = await newTenant('max@taazaa.com');
    const r = await signInWith({ oid: 'oid-evil-max', tid: 'tid-evil', email: 'max@taazaa.com' });
    expect(r.error).toBe('not_set_up');
    expect(r.description).toBe(NOT_SET_UP);
    expect(await sessionsOf(t.ownerUserId)).toHaveLength(0);
    expect(await accountsWith('oid-evil-max')).toHaveLength(0);
    const [u] = await adminDb.select().from(user).where(eq(user.id, t.ownerUserId));
    expect(u!.entraObjectId).toBeNull();
  });

  it('refuses a foreign or client tenant claiming a platform admin email; the home tenant works', async () => {
    const admin = await seedUser({ admin: true, email: 'root@taazaa.com' });
    for (const tid of ['tid-evil', 'tid-client']) {
      const r = await signInWith({ oid: `oid-${tid}-root`, tid, email: 'root@taazaa.com' });
      expect(r.error).toBe('not_set_up');
    }
    expect(await sessionsOf(admin.id)).toHaveLength(0);
    const ok = await signInWith({ oid: 'oid-root', tid: 'tid-home', email: 'root@taazaa.com' });
    expect(ok.location).toBe('/welcome');
    expect(await sessionsOf(admin.id)).toHaveLength(1);
  });

  it('refuses a second Microsoft identity that claims the email of a pinned member', async () => {
    const t = await newTenant('pat@taazaa.com');
    await activate(t.ownerMembershipId);
    await adminDb
      .update(user)
      .set({ entraObjectId: 'oid-pat', entraTenantId: 'tid-home' })
      .where(eq(user.id, t.ownerUserId));
    const r = await signInWith({ oid: 'oid-impostor', tid: 'tid-home', email: 'pat@taazaa.com' });
    expect(r.error).toBe('not_set_up');
    expect(await sessionsOf(t.ownerUserId)).toHaveLength(0);
    // The pinned object id from the wrong tenant is refused too.
    const r2 = await signInWith({ oid: 'oid-pat', tid: 'tid-evil', email: 'pat@taazaa.com' });
    expect(r2.error).toBe('not_set_up');
    expect(await sessionsOf(t.ownerUserId)).toHaveLength(0);
  });

  it('a refused link leaves no account row: re-enabled, the impostor stays out and the real user gets in', async () => {
    const t = await newTenant('sam@taazaa.com');
    await adminDb.update(user).set({ disabledAt: new Date() }).where(eq(user.id, t.ownerUserId));
    // While disabled, even an identity from an allowed tenant is refused, and nothing is linked.
    const early = await signInWith({ oid: 'oid-early', tid: 'tid-client', email: 'sam@taazaa.com' });
    expect(early.error).toBe('account_turned_off');
    expect(await accountsWith('oid-early')).toHaveLength(0);
    const evil = await signInWith({ oid: 'oid-evil-sam', tid: 'tid-evil', email: 'sam@taazaa.com' });
    expect(evil.error).toBe('not_set_up');
    expect(await accountsWith('oid-evil-sam')).toHaveLength(0);

    await adminDb.update(user).set({ disabledAt: null }).where(eq(user.id, t.ownerUserId));
    const again = await signInWith({ oid: 'oid-evil-sam', tid: 'tid-evil', email: 'sam@taazaa.com' });
    expect(again.error).toBe('not_set_up');
    const real = await signInWith({ oid: 'oid-sam', tid: 'tid-home', email: 'sam@taazaa.com' });
    expect(real.location).toBe('/welcome');
    expect(await sessionsOf(t.ownerUserId)).toHaveLength(1);
    const [u] = await adminDb.select().from(user).where(eq(user.id, t.ownerUserId));
    expect(u).toMatchObject({ entraObjectId: 'oid-sam', entraTenantId: 'tid-home' });
    // Once pinned, the early identity can no longer link.
    const late = await signInWith({ oid: 'oid-early', tid: 'tid-client', email: 'sam@taazaa.com' });
    expect(late.error).toBe('not_set_up');
  });

  it('a failure while recording the sign-in gives a friendly error, not a raw 500', async () => {
    const t = await newTenant('flaky@taazaa.com');
    await adminDb.execute(
      sql.raw(`create or replace function tenancy.test_fail_activation() returns trigger language plpgsql as
        $f$ begin if new.user_id = '${t.ownerUserId}' then raise exception 'boom'; end if; return new; end $f$`),
    );
    await adminDb.execute(
      sql.raw(`create trigger test_fail_activation before update on tenancy.membership
        for each row execute function tenancy.test_fail_activation()`),
    );
    try {
      const r = await signInWith({ oid: 'oid-flaky', email: 'flaky@taazaa.com' });
      expect(r.error).toBe('sign_in_failed');
      expect(r.description).toBe(SIGN_IN_FAILED);
      expect(await sessionsOf(t.ownerUserId)).toHaveLength(0);
    } finally {
      await adminDb.execute(sql.raw('drop trigger test_fail_activation on tenancy.membership'));
      await adminDb.execute(sql.raw('drop function tenancy.test_fail_activation()'));
    }
  });
});

describe('better-auth HTTP surface', () => {
  it('serves only social sign-in, callback, sign-out and get-session', async () => {
    const at = (path: string, method = 'GET') =>
      authHandler(new Request(`${config.publicUrl}/api/auth${path}`, { method }));
    for (const p of ['/sign-up/email', '/sign-in/email', '/list-sessions', '/update-user', '/reset-password/abc', '/ok']) {
      expect((await at(p, p.startsWith('/sign') ? 'POST' : 'GET')).status).toBe(404);
    }
    expect((await at('/get-session')).status).toBe(200);
    // The disabled paths are off in better-auth itself too, not only in our route.
    expect((await auth.handler(new Request(`${config.publicUrl}/api/auth/ok`))).status).toBe(404);
  });

  it('a callback with no state goes to the app sign-in page, not a 404', async () => {
    const res = await authHandler(new Request(`${config.publicUrl}/api/auth/callback/microsoft`));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${config.publicUrl}/signin?error=state_not_found`);
  });

  it('uses plain cookie names outside production', async () => {
    expect(config.nodeEnv).not.toBe('production');
    expect((await auth.$context).authCookies.sessionToken.name).toBe('better-auth.session_token');
  });
});
