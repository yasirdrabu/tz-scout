import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  addMember,
  assignableMembers,
  createTenant,
  listRoles,
  members,
  resolvePrincipal,
  setPrincipalCacheTtl,
  setRolePermissions,
  type Permission,
  type Principal,
} from '@/modules/tenancy';
import { membership } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { signedIn, v1Req } from '../v1/session-helpers';
import { inTenant, seedUser, uniqueSlug } from './helpers';

type Seeded = Awaited<ReturnType<typeof seedUser>>;

async function newTenant() {
  const admin = await seedUser({ admin: true });
  const owner = await seedUser({ signedIn: true });
  const slug = uniqueSlug();
  const t = await createTenant(admin.actor, { slug, name: 'T', currency: 'USD', timezone: 'UTC', ownerEmail: owner.email });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  return { tenantId: t.tenantId, slug, owner, principal: principalOf(t.tenantId, owner, PERMISSIONS) };
}

/** The Principal for a person, as the route layer would build it. */
function principalOf(tenantId: string, p: Seeded, permissions: readonly Permission[]): Principal {
  return {
    tenantId,
    kind: 'user',
    id: p.id,
    userId: p.id,
    permissions: [...permissions],
    dataLimit: { kind: 'all' },
    platformAdmin: false,
    supportAccess: false,
  };
}

const changes = (tenantId: string) =>
  adminDb
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, 'tenancy.role.permissions_changed')));

type T = Awaited<ReturnType<typeof newTenant>>;
const save = (t: T, who: Seeded, r: Parameters<typeof setRolePermissions>[1], perms: Permission[]) =>
  inTenant(t.tenantId, who.actor, (ctx) => setRolePermissions(ctx, r, perms));
const setExtras = (t: T, who: Seeded, extra: Permission[]) =>
  adminDb
    .update(membership)
    .set({ extraPermissions: extra })
    .where(and(eq(membership.tenantId, t.tenantId), eq(membership.userId, who.id)));
const roleView = async (t: T, r: string) =>
  (await inTenant(t.tenantId, t.owner.actor, (ctx) => listRoles(ctx))).find((x) => x.role === r)!;

let a: T;
let b: T;

beforeAll(async () => {
  a = await newTenant();
  b = await newTenant();
});

describe('role permissions per workspace', () => {
  it('lists every role with its defaults in ROLES order, Viewer included', async () => {
    const roles = await inTenant(a.tenantId, a.owner.actor, (ctx) => listRoles(ctx));
    expect(roles.map((r) => r.role)).toEqual(['owner', 'leader', 'seller', 'operator', 'viewer']);
    expect(roles[0]).toMatchObject({ locked: true, customised: false, permissions: [...PERMISSIONS] });
    expect(roles[4]).toMatchObject({ locked: false, customised: false, permissions: ROLE_PERMISSIONS.viewer });
  });

  it('a role saved in workspace A does not change workspace B', async () => {
    const view = await save(a, a.owner, 'seller', ['status:read', 'accounts:read', 'accounts:read']);
    expect(view).toMatchObject({ role: 'seller', permissions: ['accounts:read', 'status:read'], customised: true, locked: false });
    expect(view.defaultPermissions).toEqual(ROLE_PERMISSIONS.seller);
    expect((await roleView(a, 'seller')).customised).toBe(true);
    const inB = await roleView(b, 'seller');
    expect(inB.customised).toBe(false);
    expect(inB.permissions).toEqual(ROLE_PERMISSIONS.seller);
  });

  it('refuses to edit Owner with 409 role-locked', async () => {
    await expect(save(a, a.owner, 'owner', ['accounts:read'])).rejects.toMatchObject({
      slug: 'role-locked',
      status: 409,
      message: 'The Owner role always has every permission.',
    });
  });

  it('saving the default list makes the role not customised again', async () => {
    await save(a, a.owner, 'operator', ['accounts:read']);
    expect((await roleView(a, 'operator')).customised).toBe(true);
    const view = await save(a, a.owner, 'operator', [...ROLE_PERMISSIONS.operator].reverse());
    expect(view.customised).toBe(false);
    const rows = await adminDb.execute(sql`select 1 from tenancy.role_permission where tenant_id = ${a.tenantId} and role = 'operator'`);
    expect(rows.length).toBe(0);
  });

  it('allows an empty list and audits the diff; an unchanged save writes no audit row', async () => {
    const before = (await changes(a.tenantId)).length;
    await save(a, a.owner, 'viewer', []);
    const rows = await changes(a.tenantId);
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)!.after).toEqual({
      role: 'viewer',
      added: [],
      removed: ['accounts:read', 'offers:read', 'analytics:read', 'status:read'],
    });
    await save(a, a.owner, 'viewer', []);
    expect((await changes(a.tenantId)).length).toBe(before + 1);
  });

  it('a leader with members:manage cannot add a permission they lack, but can remove ones they hold', async () => {
    const leader = await seedUser({ signedIn: true });
    await inTenant(a.tenantId, a.owner.actor, (ctx) => addMember(ctx, { email: leader.email, role: 'leader' }));
    await setExtras(a, leader, ['members:manage']);
    const held = [...ROLE_PERMISSIONS.leader, 'members:manage' as const];
    await expect(save(a, leader, 'leader', [...held, 'keys:manage'])).rejects.toMatchObject({
      slug: 'permission-not-yours',
      status: 403,
      detail: "You can't give the `keys:manage` permission because you don't have it.",
    });
    await expect(save(a, leader, 'seller', ['accounts:read', 'keys:manage'])).rejects.toMatchObject({ slug: 'permission-not-yours' });
    // Operator's default holds offers:manage, which a leader lacks, so removing it is refused too.
    await expect(save(a, leader, 'operator', ['accounts:read'])).rejects.toMatchObject({ slug: 'permission-not-yours' });
    const view = await save(a, leader, 'seller', ['accounts:read']);
    expect(view.permissions).toEqual(['accounts:read']);
  });

  it('judges the editor by what they hold now, not by a principal cached before a permission was taken away', async () => {
    const editor = await seedUser({ signedIn: true });
    await inTenant(a.tenantId, a.owner.actor, (ctx) => addMember(ctx, { email: editor.email, role: 'seller' }));
    await setExtras(a, editor, ['members:manage', 'keys:manage']);
    await setExtras(a, editor, ['members:manage']);
    await expect(save(a, editor, 'seller', [...ROLE_PERMISSIONS.seller, 'keys:manage'])).rejects.toMatchObject({
      slug: 'permission-not-yours',
    });
  });

  it('drops a stored permission that no longer exists when reading', async () => {
    await adminDb.execute(
      sql`insert into tenancy.role_permission (tenant_id, role, permissions) values (${b.tenantId}, 'viewer', array['accounts:read', 'gone:perm'])`,
    );
    const v = await roleView(b, 'viewer');
    expect(v.permissions).toEqual(['accounts:read']);
    expect(v.customised).toBe(true);
  });
});

describe('effective permissions read the workspace sets', () => {
  it('the principal (real cache TTL), members() and assignableMembers() use the saved set', async () => {
    setPrincipalCacheTtl(60_000);
    try {
      const t = await newTenant();
      const seller = await seedUser({ signedIn: true });
      await inTenant(t.tenantId, t.owner.actor, (ctx) => addMember(ctx, { email: seller.email, role: 'seller' }));
      const cookies = await signedIn(seller.id);
      const perms = async () => (await resolvePrincipal(v1Req('/me', { cookies, tenant: t.slug }), t.slug))!.permissions;
      const assignable = async () =>
        (await inTenant(t.tenantId, t.owner.actor, (ctx) => assignableMembers(ctx))).map((m) => m.userId);
      expect(await perms()).toContain('accounts:read');
      expect(await assignable()).toContain(seller.id);

      await save(t, t.owner, 'seller', ROLE_PERMISSIONS.seller.filter((p) => p !== 'accounts:read' && p !== 'assignments:respond'));
      expect(await perms()).not.toContain('accounts:read');
      const [row] = await inTenant(t.tenantId, t.owner.actor, (ctx) => members(ctx, { roles: ['seller'] }));
      expect(row!.permissions).not.toContain('accounts:read');
      expect(await assignable()).not.toContain(seller.id);

      await save(t, t.owner, 'seller', ['assignments:respond']);
      expect(await assignable()).toContain(seller.id);
    } finally {
      setPrincipalCacheTtl(0);
    }
  });

  it('a leader can give the Viewer role only while they hold the viewer set', async () => {
    const t = await newTenant();
    const leader = await seedUser({ signedIn: true });
    await inTenant(t.tenantId, t.owner.actor, (ctx) => addMember(ctx, { email: leader.email, role: 'leader' }));
    await save(t, t.owner, 'viewer', ['accounts:read', 'keys:manage']);
    await expect(
      inTenant(t.tenantId, leader.actor, (ctx) => addMember(ctx, { email: 'v1@example.com', role: 'viewer' })),
    ).rejects.toMatchObject({ slug: 'permission-not-yours' });
    await save(t, t.owner, 'viewer', ROLE_PERMISSIONS.viewer);
    await expect(
      inTenant(t.tenantId, leader.actor, (ctx) => addMember(ctx, { email: 'v2@example.com', role: 'viewer' })),
    ).resolves.toBeTruthy();
  });
});
