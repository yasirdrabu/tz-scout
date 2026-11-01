import { and, eq } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { ROLES, type Role } from '../contracts/members';
import { PERMISSIONS, ROLE_PERMISSIONS, isPermission, roleSet, type Permission, type RoleSets } from '../domain/permissions';
import { rolePermission } from '../db/schema';
import { actorPermissions } from './members';
import { forgetAccess } from './principal';
import { loadRoleSets } from './role-sets';

export { loadRoleSets };

/** One role as the roles matrix shows it. `permissions` is what the workspace's role holds now. */
export type RoleView = {
  role: Role;
  permissions: Permission[];
  defaultPermissions: Permission[];
  customised: boolean;
  locked: boolean;
};

function view(role: Role, sets: RoleSets): RoleView {
  return {
    role,
    permissions: roleSet(role, sets),
    defaultPermissions: [...ROLE_PERMISSIONS[role]],
    customised: role !== 'owner' && sets[role] !== undefined,
    locked: role === 'owner',
  };
}

/** Every role in `ROLES` order with its current and default permissions. */
export async function listRoles(ctx: ModuleContext): Promise<RoleView[]> {
  const sets = await loadRoleSets(ctx);
  return ROLES.map((role) => view(role, sets));
}

/**
 * Replaces one role's permission list for the workspace. Owner is locked. Unless the actor is a
 * platform admin, every permission added or removed must be one they hold themselves. A list equal to
 * the default removes the saved row. Nothing is written or audited when the list does not change.
 * Cached principals are dropped here and should be dropped again once the transaction commits (the
 * route does), so a request that loaded the old set mid-transaction does not keep it for 60 seconds.
 */
export async function setRolePermissions(
  ctx: ModuleContext,
  role: Role,
  permissions: Permission[],
): Promise<RoleView> {
  if (role === 'owner') {
    throw new ScoutError({ slug: 'role-locked', status: 409, title: 'The Owner role always has every permission.' });
  }
  if (!permissions.every(isPermission)) {
    throw new ScoutError({ slug: 'invalid-permission', status: 400, title: 'That permission does not exist.' });
  }
  const sets = await loadRoleSets(ctx);
  const wanted = new Set<Permission>(permissions);
  const next = PERMISSIONS.filter((p) => wanted.has(p));
  const current = new Set(roleSet(role, sets));
  const added = next.filter((p) => !current.has(p));
  const removed = PERMISSIONS.filter((p) => current.has(p) && !wanted.has(p));
  if (added.length === 0 && removed.length === 0) return view(role, sets);

  // Read fresh: a cached principal can still hold a permission taken away in the last minute.
  const held = new Set(await actorPermissions(ctx));
  const notYours = [...added, ...removed].find((p) => !held.has(p));
  if (notYours) {
    throw new ScoutError({
      slug: 'permission-not-yours',
      status: 403,
      title: 'Not available to you',
      detail: `You can't give the \`${notYours}\` permission because you don't have it.`,
    });
  }

  const isDefault = next.length === ROLE_PERMISSIONS[role].length && ROLE_PERMISSIONS[role].every((p) => wanted.has(p));
  if (isDefault) {
    await ctx.tx.delete(rolePermission).where(and(eq(rolePermission.tenantId, ctx.tenantId), eq(rolePermission.role, role)));
    delete sets[role];
  } else {
    await ctx.tx
      .insert(rolePermission)
      .values({ tenantId: ctx.tenantId, role, permissions: next, updatedBy: ctx.actor.id })
      .onConflictDoUpdate({
        target: [rolePermission.tenantId, rolePermission.role],
        set: { permissions: next, updatedBy: ctx.actor.id, updatedAt: new Date() },
      });
    sets[role] = next;
  }
  await audit(ctx, {
    action: 'tenancy.role.permissions_changed',
    subject: { type: 'role', id: role },
    after: { role, added, removed },
  });
  forgetAccess({ tenantId: ctx.tenantId });
  return view(role, sets);
}
