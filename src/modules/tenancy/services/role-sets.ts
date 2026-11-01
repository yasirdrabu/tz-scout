import { eq } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { ROLES, type Role } from '../contracts/members';
import { isPermission, type RoleSets } from '../domain/permissions';
import { rolePermission } from '../db/schema';

/** The workspace's saved role lists. A role with no row is absent; unknown permission strings are dropped. */
export async function loadRoleSets(ctx: ModuleContext): Promise<RoleSets> {
  const rows = await ctx.tx
    .select({ role: rolePermission.role, permissions: rolePermission.permissions })
    .from(rolePermission)
    .where(eq(rolePermission.tenantId, ctx.tenantId));
  const sets: RoleSets = {};
  for (const r of rows) {
    if ((ROLES as readonly string[]).includes(r.role)) sets[r.role as Role] = r.permissions.filter(isPermission);
  }
  return sets;
}
