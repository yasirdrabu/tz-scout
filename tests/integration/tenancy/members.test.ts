import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  changeMember,
  createTenant,
  crmOwnerId,
  members,
  removeMember,
  setCrmOwnerIds,
  tenantsFor,
  userForCrmOwner,
} from '@/modules/tenancy';
import { membership, user } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import type { Actor } from '@/platform/events/envelope';
import { inTenant, seedUser, uniqueSlug } from './helpers';

let tenantId: string;
let ownerId: string;
let owner: Actor;

async function newTenant() {
  const admin = await seedUser({ admin: true });
  const o = await seedUser({ signedIn: true });
  const t = await createTenant(admin.actor, {
    slug: uniqueSlug(),
    name: 'T',
    currency: 'USD',
    timezone: 'UTC',
    ownerEmail: o.email,
  });
  // The owner has signed in: activate (sign-in itself arrives in Task 11).
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  return { tenantId: t.tenantId, ownerMembershipId: t.ownerMembershipId, owner: o };
}

const events = async (tid: string, type: string) =>
  (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${tid} and payload->>'type' = ${type} order by seq`,
  )) as unknown as { payload: { data: Record<string, unknown> } }[];

beforeAll(async () => {
  const t = await newTenant();
  tenantId = t.tenantId;
  ownerId = t.owner.id;
  owner = t.owner.actor;
});

describe('addMember / removeMember', () => {
  it('adds an unseen person as invited and publishes member.added (TEN-E1-S2-AC1)', async () => {
    const id = await inTenant(tenantId, owner, (ctx) =>
      addMember(ctx, { email: 'New.Seller@Example.com', role: 'seller' }),
    );
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, id));
    expect(m).toMatchObject({ status: 'invited', role: 'seller', invitedBy: ownerId });
    const ev = (await events(tenantId, 'tenancy.member.added')).map((e) => e.payload.data);
    expect(ev).toContainEqual({ userId: m!.userId, role: 'seller', invitedBy: ownerId });
    const [u] = await adminDb.select().from(user).where(eq(user.id, m!.userId));
    expect(u!.email).toBe('new.seller@example.com');
  });

  it('adds a signed-in person as active', async () => {
    const p = await seedUser({ signedIn: true });
    const id = await inTenant(tenantId, owner, (ctx) => addMember(ctx, { email: p.email, role: 'leader' }));
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, id));
    expect(m!.status).toBe('active');
  });

  it('refuses a person who is already a member', async () => {
    const p = await seedUser({ signedIn: true });
    await inTenant(tenantId, owner, (ctx) => addMember(ctx, { email: p.email, role: 'seller' }));
    await expect(
      inTenant(tenantId, owner, (ctx) => addMember(ctx, { email: p.email, role: 'seller' })),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('removing publishes member.removed and hides the member (TEN-E1-S2-AC2)', async () => {
    const p = await seedUser({ signedIn: true });
    const id = await inTenant(tenantId, owner, (ctx) => addMember(ctx, { email: p.email, role: 'seller' }));
    await inTenant(tenantId, owner, (ctx) => removeMember(ctx, id));
    const ev = (await events(tenantId, 'tenancy.member.removed')).map((e) => e.payload.data);
    expect(ev).toContainEqual({ userId: p.id, removedBy: ownerId });
    const list = await inTenant(tenantId, owner, (ctx) => members(ctx, {}));
    expect(list.find((m) => m.userId === p.id)).toBeUndefined();
    // Can be added again later.
    const again = await inTenant(tenantId, owner, (ctx) => addMember(ctx, { email: p.email, role: 'operator' }));
    expect(again).toBe(id);
  });

  it('refuses to remove or demote the last active owner (TEN-E1-S2-AC3)', async () => {
    const t = await newTenant();
    const a = t.owner.actor;
    await expect(inTenant(t.tenantId, a, (ctx) => removeMember(ctx, t.ownerMembershipId))).rejects.toThrow(
      'A tenant needs at least one owner.',
    );
    await expect(
      inTenant(t.tenantId, a, (ctx) => changeMember(ctx, t.ownerMembershipId, { role: 'leader' })),
    ).rejects.toThrow('A tenant needs at least one owner.');
  });

  it('allows removing an owner when another active owner exists, and does not count invited owners', async () => {
    const t = await newTenant();
    const a = t.owner.actor;
    const second = await seedUser({ signedIn: true });
    const secondId = await inTenant(t.tenantId, a, (ctx) => addMember(ctx, { email: second.email, role: 'owner' }));
    await inTenant(t.tenantId, a, (ctx) => removeMember(ctx, secondId)); // fine: first owner remains
    const invitedOwner = await inTenant(t.tenantId, a, (ctx) =>
      addMember(ctx, { email: 'inv@example.com', role: 'owner' }),
    );
    // Invited owner does not count, so the active owner is still the last one.
    await expect(inTenant(t.tenantId, a, (ctx) => removeMember(ctx, t.ownerMembershipId))).rejects.toThrow(
      'A tenant needs at least one owner.',
    );
    await inTenant(t.tenantId, a, (ctx) => removeMember(ctx, invitedOwner)); // removing an invited owner is fine
  });

  it('a brand-new tenant whose only owner is invited can still add members and keeps the owner', async () => {
    const admin = await seedUser({ admin: true });
    const t = await createTenant(admin.actor, {
      slug: uniqueSlug(),
      name: 'T',
      currency: 'USD',
      timezone: 'UTC',
      ownerEmail: 'brandnew@example.com',
    });
    await inTenant(t.tenantId, admin.actor, (ctx) => addMember(ctx, { email: 'x@example.com', role: 'seller' }));
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, t.ownerMembershipId));
    expect(m!.status).toBe('invited');
  });
});

describe('changeMember', () => {
  it('publishes role_changed and audits before and after (TEN-E1-S3-AC2)', async () => {
    const id = await inTenant(tenantId, owner, (ctx) => addMember(ctx, { email: 'chg@example.com', role: 'seller' }));
    await inTenant(tenantId, owner, (ctx) =>
      changeMember(ctx, id, { role: 'leader', extraPermissions: ['people:read'], dataLimit: { practices: ['ai'] } }),
    );
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, id));
    expect(m).toMatchObject({ role: 'leader', extraPermissions: ['people:read'], dataLimit: { practices: ['ai'] } });
    const ev = (await events(tenantId, 'tenancy.member.role_changed')).map((e) => e.payload.data);
    expect(ev).toContainEqual({ userId: m!.userId, from: 'seller', to: 'leader' });
    const rows = await adminDb.select().from(auditLog).where(eq(auditLog.subjectId, id));
    const row = rows.find((r) => r.action === 'tenancy.member.changed')!;
    expect(row.tenantId).toBe(tenantId);
    expect(row.before).toMatchObject({ role: 'seller' });
    expect(row.after).toMatchObject({ role: 'leader', extraPermissions: ['people:read'] });
  });

  it('does not publish role_changed when only the data limit changes', async () => {
    const id = await inTenant(tenantId, owner, (ctx) => addMember(ctx, { email: 'dl@example.com', role: 'seller' }));
    const before = (await events(tenantId, 'tenancy.member.role_changed')).length;
    await inTenant(tenantId, owner, (ctx) => changeMember(ctx, id, { dataLimit: { practices: ['x'] } }));
    expect((await events(tenantId, 'tenancy.member.role_changed')).length).toBe(before);
  });
});

describe('CRM owner ids', () => {
  it('finds an invited seller by CRM owner id and refuses a duplicate (TEN-E1-S4-AC3, AC4)', async () => {
    const id = await inTenant(tenantId, owner, (ctx) =>
      addMember(ctx, { email: 'ash@example.com', role: 'seller', crmOwnerIds: { hubspot: '123' } }),
    );
    const [m] = await adminDb.select().from(membership).where(eq(membership.id, id));
    expect(m!.status).toBe('invited');
    const found = await inTenant(tenantId, owner, (ctx) => userForCrmOwner(ctx, 'hubspot', '123'));
    expect(found).toBe(m!.userId);
    expect(await inTenant(tenantId, owner, (ctx) => crmOwnerId(ctx, m!.userId, 'hubspot'))).toBe('123');
    expect(await inTenant(tenantId, owner, (ctx) => crmOwnerId(ctx, m!.userId, 'other'))).toBeNull();
    expect(await inTenant(tenantId, owner, (ctx) => userForCrmOwner(ctx, 'hubspot', '999'))).toBeNull();

    await expect(
      inTenant(tenantId, owner, (ctx) =>
        addMember(ctx, { email: 'mike@example.com', role: 'seller', crmOwnerIds: { hubspot: '123' } }),
      ),
    ).rejects.toThrow('That CRM user is already linked to someone else.');
    const other = await inTenant(tenantId, owner, (ctx) =>
      addMember(ctx, { email: 'andy@example.com', role: 'seller' }),
    );
    await expect(inTenant(tenantId, owner, (ctx) => setCrmOwnerIds(ctx, other, { hubspot: '123' }))).rejects.toThrow(
      'That CRM user is already linked to someone else.',
    );
    await inTenant(tenantId, owner, (ctx) => setCrmOwnerIds(ctx, other, { hubspot: '456' }));
    // Re-saving a membership's own id is fine.
    await inTenant(tenantId, owner, (ctx) => setCrmOwnerIds(ctx, other, { hubspot: '456' }));
  });

  it('allows the same owner id in another tenant, and frees it when the member is removed', async () => {
    const t2 = await newTenant();
    await inTenant(t2.tenantId, t2.owner.actor, (ctx) =>
      addMember(ctx, { email: 'other-tenant@example.com', role: 'seller', crmOwnerIds: { hubspot: '777' } }),
    );
    const id = await inTenant(tenantId, owner, (ctx) =>
      addMember(ctx, { email: 'same@example.com', role: 'seller', crmOwnerIds: { hubspot: '777' } }),
    );
    await inTenant(tenantId, owner, (ctx) => removeMember(ctx, id));
    await inTenant(tenantId, owner, (ctx) =>
      addMember(ctx, { email: 'again@example.com', role: 'seller', crmOwnerIds: { hubspot: '777' } }),
    );
  });
});

describe('members and tenantsFor', () => {
  it('lists members with name, email, role and status; filters by roles', async () => {
    const t = await newTenant();
    await inTenant(t.tenantId, t.owner.actor, (ctx) => addMember(ctx, { email: 'sel@example.com', role: 'seller' }));
    const all = await inTenant(t.tenantId, t.owner.actor, (ctx) => members(ctx, {}));
    expect(all).toHaveLength(2);
    expect(all.find((m) => m.email === 'sel@example.com')).toMatchObject({
      role: 'seller',
      status: 'invited',
      permissions: [],
    });
    const sellers = await inTenant(t.tenantId, t.owner.actor, (ctx) => members(ctx, { roles: ['seller'] }));
    expect(sellers.map((m) => m.email)).toEqual(['sel@example.com']);
  });

  it('tenantsFor omits removed memberships (TEN-E1-S5-AC1)', async () => {
    const t1 = await newTenant();
    const t2 = await newTenant();
    const p = await seedUser({ signedIn: true });
    const m1 = await inTenant(t1.tenantId, t1.owner.actor, (ctx) =>
      addMember(ctx, { email: p.email, role: 'seller' }),
    );
    await inTenant(t2.tenantId, t2.owner.actor, (ctx) => addMember(ctx, { email: p.email, role: 'seller' }));
    expect((await tenantsFor(p.id)).map((t) => t.id).sort()).toEqual([t1.tenantId, t2.tenantId].sort());
    await inTenant(t1.tenantId, t1.owner.actor, (ctx) => removeMember(ctx, m1));
    const left = await tenantsFor(p.id);
    expect(left.map((t) => t.id)).toEqual([t2.tenantId]);
    expect(Object.keys(left[0]!).sort()).toEqual(['id', 'name', 'slug']);
  });

  it('does not leak members across tenants', async () => {
    const t = await newTenant();
    const list = await inTenant(t.tenantId, t.owner.actor, (ctx) => members(ctx, {}));
    expect(list.every((m) => m.userId !== ownerId)).toBe(true);
  });
});
