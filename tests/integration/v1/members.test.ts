import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as listMembers, POST as invite } from '@/app/v1/members/route';
import { DELETE as remove, PATCH as patch, POST as act } from '@/app/v1/members/[id]/route';
import { GET as roles } from '@/app/v1/roles/route';
import { GET as me } from '@/app/v1/me/route';
import { ACCOUNT_TURNED_OFF, ROLE_PERMISSIONS, addMember, checkSignIn, completeSignIn, setPrincipalCacheTtl } from '@/modules/tenancy';
import { assignment } from '@/modules/routing/db/schema';
import { membership, session, user } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { inTenant, seedUser } from '../tenancy/helpers';
import { signedIn, tenantOwnedBy, v1Req, type Person, type ReqOpts } from './session-helpers';

let admin: Person;
let owner: Person;
let leader: Person;
let seller: Person;
let t: { tenantId: string; slug: string; ownerMembershipId: string };
const cookies: Record<string, Headers> = {};
const ids: Record<string, string> = {};

beforeAll(async () => {
  admin = await seedUser({ admin: true, signedIn: true });
  owner = await seedUser({ signedIn: true });
  leader = await seedUser({ signedIn: true });
  seller = await seedUser({ signedIn: true });
  t = await tenantOwnedBy(admin, owner.email);
  ids[owner.id] = t.ownerMembershipId;
  await inTenant(t.tenantId, owner.actor, async (ctx) => {
    ids[leader.id] = await addMember(ctx, { email: leader.email, role: 'leader' });
    ids[seller.id] = await addMember(ctx, { email: seller.email, role: 'seller' });
  });
  for (const p of [owner, leader, seller]) cookies[p.id] = await signedIn(p.id);
});
beforeEach(() => setPrincipalCacheTtl(0));

const as = (p: Person, path: string, opts: Omit<ReqOpts, 'cookies' | 'tenant'> = {}) =>
  v1Req(path, { ...opts, cookies: cookies[p.id], tenant: t.slug });

/** A seller (signed in, active) who can be suspended, removed and so on without upsetting other tests. */
async function freshSeller() {
  const p = await seedUser({ signedIn: true });
  const id = await inTenant(t.tenantId, owner.actor, (ctx) => addMember(ctx, { email: p.email, role: 'seller' }));
  cookies[p.id] = await signedIn(p.id);
  return { ...p, membershipId: id };
}

describe('GET /v1/members', () => {
  it('lists members with role, status, sign-in facts, practice access and open accounts', async () => {
    await adminDb.insert(assignment).values({
      id: newId('asg'),
      tenantId: t.tenantId,
      accountId: newId('acc'),
      sellerUserId: seller.id,
      assignedBy: owner.id,
    });
    const invitedId = await inTenant(t.tenantId, owner.actor, (ctx) => addMember(ctx, { email: `inv-${newId('usr')}@example.com`.toLowerCase(), role: 'seller' }));
    const res = await listMembers(as(owner, '/members'));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const s = data.find((m: { id: string }) => m.id === ids[seller.id]);
    expect(s).toMatchObject({
      id: ids[seller.id],
      user_id: seller.id,
      name: seller.email.split('@')[0],
      email: seller.email,
      role: 'seller',
      status: 'active',
      sign_in_method: 'dev',
      data_limit: null,
      crm_owner_ids: {},
      extra_permissions: [],
      open_account_count: 1,
    });
    expect(Date.parse(s.last_active_at)).toBeGreaterThan(Date.now() - 60_000);
    const inv = data.find((m: { id: string }) => m.id === invitedId);
    expect(inv).toMatchObject({ status: 'invited', sign_in_method: null, last_active_at: null, open_account_count: 0 });
  });

  it('is open to members:read (leader) and refused to a seller', async () => {
    expect((await listMembers(as(leader, '/members'))).status).toBe(200);
    expect((await listMembers(as(seller, '/members'))).status).toBe(403);
  });
});

describe('POST /v1/members', () => {
  it('invites each address with the role and practice access, and reports per address', async () => {
    const fresh = `new-${newId('usr')}@example.com`.toLowerCase();
    const res = await invite(
      as(owner, '/members', {
        method: 'POST',
        body: { emails: [fresh, ` ${seller.email.toUpperCase()} `, 'not-an-email'], role: 'seller', data_limit: { kind: 'practices', ids: ['prc_1'] } },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sign_in_url).toBe('http://localhost:4240/signin');
    expect(body.results).toEqual([
      { email: fresh, ok: true, membership_id: expect.stringMatching(/^mbr_/), status: 'invited' },
      { email: seller.email, ok: false, error: { slug: 'already-member', title: 'Already a member' } },
      { email: 'not-an-email', ok: false, error: { slug: 'invalid-email', title: 'That is not an email address.' } },
    ]);
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, body.results[0].membership_id));
    expect(m).toMatchObject({ role: 'seller', status: 'invited', dataLimit: { kind: 'practices', ids: ['prc_1'] } });
  });

  it('refuses a leader (no members:manage), a bad role and an empty list', async () => {
    expect((await invite(as(leader, '/members', { method: 'POST', body: { emails: ['a@example.com'], role: 'seller' } }))).status).toBe(403);
    const bad = await invite(as(owner, '/members', { method: 'POST', body: { emails: ['a@example.com'], role: 'boss' } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).type).toMatch(/\/validation$/);
    expect((await invite(as(owner, '/members', { method: 'POST', body: { emails: [], role: 'seller' } }))).status).toBe(400);
  });
});

describe('PATCH /v1/members/{id}', () => {
  it('changes role, practice access and the CRM user id, and audits it', async () => {
    const p = await freshSeller();
    const res = await patch(
      as(owner, `/members/${p.membershipId}`, {
        method: 'PATCH',
        body: { role: 'leader', data_limit: { kind: 'practices', ids: ['prc_a', 'prc_b'] }, crm_owner_ids: { hubspot: `h${p.id}` } },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: p.membershipId,
      role: 'leader',
      data_limit: { kind: 'practices', ids: ['prc_a', 'prc_b'] },
      crm_owner_ids: { hubspot: `h${p.id}` },
    });
    const rows = await adminDb.select().from(auditLog).where(and(eq(auditLog.subjectId, p.membershipId), eq(auditLog.action, 'tenancy.member.changed')));
    expect(rows).toHaveLength(1);
    // Back to the role default.
    const reset = await patch(as(owner, `/members/${p.membershipId}`, { method: 'PATCH', body: { data_limit: null } }));
    expect((await reset.json()).data_limit).toBeNull();
  });

  it('refuses changing your own role, but saving the same role is fine', async () => {
    const res = await patch(as(owner, `/members/${ids[owner.id]}`, { method: 'PATCH', body: { role: 'leader' } }));
    expect(res.status).toBe(403);
    expect((await res.json()).type).toMatch(/\/not-yourself$/);
    expect((await patch(as(owner, `/members/${ids[owner.id]}`, { method: 'PATCH', body: { role: 'owner' } }))).status).toBe(200);
  });

  it('refuses a leader, an unknown field and an unknown member', async () => {
    expect((await patch(as(leader, `/members/${ids[seller.id]}`, { method: 'PATCH', body: { role: 'operator' } }))).status).toBe(403);
    const bad = await patch(as(owner, `/members/${ids[seller.id]}`, { method: 'PATCH', body: { colour: 'red' } }));
    expect(bad.status).toBe(400);
    expect((await patch(as(owner, '/members/mbr_nope', { method: 'PATCH', body: { role: 'seller' } }))).status).toBe(404);
  });
});

describe('suspend and reactivate', () => {
  it('a suspended member cannot use the workspace until reactivated', async () => {
    const p = await freshSeller();
    expect((await me(as(p, '/me'))).status).toBe(200);
    const res = await act(as(owner, `/members/${p.membershipId}:suspend`, { method: 'POST' }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('suspended');
    expect((await me(as(p, '/me'))).status).toBe(401);
    const list = (await (await listMembers(as(owner, '/members'))).json()).data;
    expect(list.find((m: { id: string }) => m.id === p.membershipId).status).toBe('suspended');

    const back = await act(as(owner, `/members/${p.membershipId}:reactivate`, { method: 'POST' }));
    expect(back.status).toBe(200);
    expect((await back.json()).status).toBe('active');
    expect((await me(as(p, '/me'))).status).toBe(200);
    const actions = (await adminDb.select().from(auditLog).where(eq(auditLog.subjectId, p.membershipId))).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['tenancy.member.suspended', 'tenancy.member.reactivated']));
  });

  it('a person suspended everywhere cannot sign in, and signing in does not reactivate them', async () => {
    const p = await freshSeller();
    await act(as(owner, `/members/${p.membershipId}:suspend`, { method: 'POST' }));
    expect(await checkSignIn({ userId: p.id })).toEqual({ ok: false, message: ACCOUNT_TURNED_OFF });
    await completeSignIn(p.id);
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, p.membershipId));
    expect(m!.status).toBe('suspended');
  });

  it('refuses suspending an owner, yourself, an invited member, and reactivating an active one', async () => {
    const other = await seedUser({ signedIn: true });
    const otherOwner = await inTenant(t.tenantId, owner.actor, (ctx) => addMember(ctx, { email: other.email, role: 'owner' }));
    const r1 = await act(as(owner, `/members/${otherOwner}:suspend`, { method: 'POST' }));
    expect(r1.status).toBe(409);
    expect((await r1.json()).type).toMatch(/\/owner-protected$/);
    expect((await act(as(owner, `/members/${ids[owner.id]}:suspend`, { method: 'POST' }))).status).toBe(403);
    const invited = await inTenant(t.tenantId, owner.actor, (ctx) => addMember(ctx, { email: `i-${newId('usr')}@example.com`.toLowerCase(), role: 'seller' }));
    expect((await act(as(owner, `/members/${invited}:suspend`, { method: 'POST' }))).status).toBe(409);
    expect((await act(as(owner, `/members/${ids[seller.id]}:reactivate`, { method: 'POST' }))).status).toBe(409);
    expect((await act(as(leader, `/members/${ids[seller.id]}:suspend`, { method: 'POST' }))).status).toBe(403);
    expect((await act(as(owner, `/members/${ids[seller.id]}:promote`, { method: 'POST' }))).status).toBe(404);
  });
});

describe('POST /v1/members/{id}:sign-out-everywhere', () => {
  it('ends every session of that person', async () => {
    const p = await freshSeller();
    await signedIn(p.id); // a second device
    expect(await adminDb.select().from(session).where(eq(session.userId, p.id))).toHaveLength(2);
    const res = await act(as(owner, `/members/${p.membershipId}:sign-out-everywhere`, { method: 'POST' }));
    expect(res.status).toBe(204);
    expect(await adminDb.select().from(session).where(eq(session.userId, p.id))).toHaveLength(0);
    expect((await me(as(p, '/me'))).status).toBe(401);
    expect((await act(as(leader, `/members/${ids[seller.id]}:sign-out-everywhere`, { method: 'POST' }))).status).toBe(403);
  });
});

describe('DELETE /v1/members/{id}', () => {
  it('removes the member and announces it, so their open accounts go back to the queue', async () => {
    const p = await freshSeller();
    const res = await remove(as(owner, `/members/${p.membershipId}`, { method: 'DELETE' }));
    expect(res.status).toBe(204);
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, p.membershipId));
    expect(m!.status).toBe('removed');
    const events = await adminDb.execute(
      sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = 'tenancy.member.removed' and payload->'data'->>'userId' = ${p.id}`,
    );
    expect(events).toHaveLength(1);
  });

  it('refuses removing an active owner or yourself, and a leader', async () => {
    const other = await seedUser({ signedIn: true });
    const otherOwner = await inTenant(t.tenantId, owner.actor, (ctx) => addMember(ctx, { email: other.email, role: 'owner' }));
    expect((await remove(as(owner, `/members/${otherOwner}`, { method: 'DELETE' }))).status).toBe(409);
    expect((await remove(as(owner, `/members/${ids[owner.id]}`, { method: 'DELETE' }))).status).toBe(403);
    expect((await remove(as(leader, `/members/${ids[seller.id]}`, { method: 'DELETE' }))).status).toBe(403);
  });
});

describe('GET /v1/roles', () => {
  it('lists each role with its permissions, and the permissions with labels and groups', async () => {
    const res = await roles(as(leader, '/roles'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles).toContainEqual({ role: 'seller', permissions: ROLE_PERMISSIONS.seller });
    expect(body.roles.map((r: { role: string }) => r.role)).toEqual(['owner', 'leader', 'seller', 'operator']);
    expect(body.permissions).toContainEqual({ key: 'members:read', label: 'See members', group: 'Workspace' });
    expect((await roles(as(seller, '/roles'))).status).toBe(403);
  });
});

describe('members:manage held as an extra permission cannot escalate', () => {
  let manager: Person & { membershipId: string };
  beforeAll(async () => {
    const p = await seedUser({ signedIn: true });
    const id = await inTenant(t.tenantId, owner.actor, (ctx) => addMember(ctx, { email: p.email, role: 'leader' }));
    await adminDb.update(membership).set({ extraPermissions: ['members:manage'] }).where(eq(membership.id, id));
    cookies[p.id] = await signedIn(p.id);
    manager = { ...p, membershipId: id };
  });

  it('refuses changing your own extra permissions', async () => {
    const res = await patch(as(manager, `/members/${manager.membershipId}`, { method: 'PATCH', body: { extra_permissions: ['members:manage', 'audit:read'] } }));
    expect(res.status).toBe(403);
    expect((await res.json()).type).toMatch(/\/not-yourself$/);
    // Sending your current set unchanged is fine.
    expect((await patch(as(manager, `/members/${manager.membershipId}`, { method: 'PATCH', body: { extra_permissions: ['members:manage'] } }))).status).toBe(200);
  });

  it('refuses inviting an owner', async () => {
    const res = await invite(as(manager, '/members', { method: 'POST', body: { emails: [`o-${newId('usr')}@example.com`.toLowerCase()], role: 'owner' } }));
    expect(res.status).toBe(403);
    expect((await res.json()).type).toMatch(/\/owners-only$/);
  });

  it("refuses making someone an owner or changing an owner's role", async () => {
    const p = await freshSeller();
    const up = await patch(as(manager, `/members/${p.membershipId}`, { method: 'PATCH', body: { role: 'owner' } }));
    expect(up.status).toBe(403);
    expect((await up.json()).type).toMatch(/\/owners-only$/);
    expect((await patch(as(manager, `/members/${ids[owner.id]}`, { method: 'PATCH', body: { role: 'seller' } }))).status).toBe(403);
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, p.membershipId));
    expect(m!.role).toBe('seller');
  });

  it('refuses granting a permission the manager does not hold, and allows one they do', async () => {
    const p = await freshSeller();
    const res = await patch(as(manager, `/members/${p.membershipId}`, { method: 'PATCH', body: { extra_permissions: ['audit:read'] } }));
    expect(res.status).toBe(403);
    expect((await res.json()).type).toMatch(/\/permission-not-yours$/);
    expect((await patch(as(manager, `/members/${p.membershipId}`, { method: 'PATCH', body: { extra_permissions: ['assign:act'] } }))).status).toBe(200);
  });

  it('refuses giving a role with a permission the manager does not hold, and allows one within theirs', async () => {
    const p = await freshSeller();
    const up = await patch(as(manager, `/members/${p.membershipId}`, { method: 'PATCH', body: { role: 'operator' } }));
    expect(up.status).toBe(403);
    expect((await up.json()).type).toMatch(/\/permission-not-yours$/);
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, p.membershipId));
    expect(m!.role).toBe('seller');
    const email = `op-${newId('usr')}@example.com`.toLowerCase();
    const inv = await invite(as(manager, '/members', { method: 'POST', body: { emails: [email], role: 'operator' } }));
    expect(inv.status).toBe(403);
    expect((await inv.json()).type).toMatch(/\/permission-not-yours$/);
    expect(await adminDb.select().from(membership).innerJoin(user, eq(user.id, membership.userId)).where(eq(user.email, email))).toHaveLength(0);
    await expect(
      inTenant(t.tenantId, manager.actor, (ctx) => addMember(ctx, { email, role: 'operator' })),
    ).rejects.toMatchObject({ slug: 'permission-not-yours' });
    // A leader holds every seller permission, so a seller can become a leader.
    expect((await patch(as(manager, `/members/${p.membershipId}`, { method: 'PATCH', body: { role: 'leader' } }))).status).toBe(200);
  });

  it('an owner can still make owners', async () => {
    const p = await freshSeller();
    const res = await patch(as(owner, `/members/${p.membershipId}`, { method: 'PATCH', body: { role: 'owner' } }));
    expect(res.status).toBe(200);
  });
});

describe('a member manager cannot give practice access wider than their own', () => {
  let manager: Person & { membershipId: string };
  const mine = { kind: 'practices', ids: ['prc_mine'] };
  beforeAll(async () => {
    const p = await seedUser({ signedIn: true });
    const id = await inTenant(t.tenantId, owner.actor, (ctx) => addMember(ctx, { email: p.email, role: 'leader' }));
    await adminDb.update(membership).set({ extraPermissions: ['members:manage'], dataLimit: mine }).where(eq(membership.id, id));
    cookies[p.id] = await signedIn(p.id);
    manager = { ...p, membershipId: id };
  });

  it('PATCH refuses a wider limit and the wider role default, and allows one within theirs', async () => {
    const p = await freshSeller();
    const path = `/members/${p.membershipId}`;
    for (const data_limit of [{ kind: 'all' }, { kind: 'practices', ids: ['prc_mine', 'prc_other'] }]) {
      const res = await patch(as(manager, path, { method: 'PATCH', body: { data_limit } }));
      expect(res.status).toBe(403);
      expect((await res.json()).type).toMatch(/\/data-limit-not-yours$/);
    }
    expect((await patch(as(manager, path, { method: 'PATCH', body: { data_limit: mine } }))).status).toBe(200);
    // Back to the seller default (their own accounts, wherever they are) or a leader's (everything) is wider.
    expect((await patch(as(manager, path, { method: 'PATCH', body: { data_limit: null } }))).status).toBe(403);
    expect((await patch(as(manager, path, { method: 'PATCH', body: { role: 'leader', data_limit: null } }))).status).toBe(403);
    // A role change that keeps the limit is fine.
    expect((await patch(as(manager, path, { method: 'PATCH', body: { role: 'leader' } }))).status).toBe(200);
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, p.membershipId));
    expect(m).toMatchObject({ role: 'leader', dataLimit: mine });
  });

  it('invite refuses a wider limit or none, and allows one within theirs', async () => {
    const email = () => `dl-${newId('usr')}@example.com`.toLowerCase();
    for (const data_limit of [{ kind: 'practices', ids: ['prc_other'] }, null]) {
      const res = await invite(as(manager, '/members', { method: 'POST', body: { emails: [email()], role: 'seller', data_limit } }));
      expect(res.status).toBe(403);
      expect((await res.json()).type).toMatch(/\/data-limit-not-yours$/);
    }
    const ok = await invite(as(manager, '/members', { method: 'POST', body: { emails: [email()], role: 'seller', data_limit: mine } }));
    expect(ok.status).toBe(200);
    const [r] = (await ok.json()).results;
    expect(r.ok).toBe(true);
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, r.membership_id));
    expect(m!.dataLimit).toEqual(mine);
  });

  it('an owner (who sees everything) can give any limit', async () => {
    const p = await freshSeller();
    const res = await patch(as(owner, `/members/${p.membershipId}`, { method: 'PATCH', body: { data_limit: { kind: 'practices', ids: ['prc_other'] } } }));
    expect(res.status).toBe(200);
  });
});

describe("another tenant's ids are not found and left alone", () => {
  let other: { tenantId: string; membershipId: string };
  beforeAll(async () => {
    const admin = await seedUser({ admin: true });
    const o = await seedUser({ signedIn: true });
    const t2 = await tenantOwnedBy(admin, o.email, 'Other Co');
    const s = await seedUser({ signedIn: true });
    const membershipId = await inTenant(t2.tenantId, o.actor, (ctx) => addMember(ctx, { email: s.email, role: 'seller' }));
    other = { tenantId: t2.tenantId, membershipId };
  });

  it('PATCH, suspend, sign out everywhere and DELETE answer 404', async () => {
    const id = other.membershipId;
    expect((await patch(as(owner, `/members/${id}`, { method: 'PATCH', body: { role: 'leader' } }))).status).toBe(404);
    expect((await act(as(owner, `/members/${id}:suspend`, { method: 'POST' }))).status).toBe(404);
    expect((await act(as(owner, `/members/${id}:sign-out-everywhere`, { method: 'POST' }))).status).toBe(404);
    expect((await remove(as(owner, `/members/${id}`, { method: 'DELETE' }))).status).toBe(404);
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, id));
    expect(m).toMatchObject({ role: 'seller', status: 'active' });
  });
});
