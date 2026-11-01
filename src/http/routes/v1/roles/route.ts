import { PERMISSIONS, listRoles, permissionGroup, permissionLabel } from '@/modules/tenancy';
import { requireMembersRead } from '../_lib/members';
import { v1Route } from '../_lib/v1-route';

/** Each role's current and default permissions for this workspace, and the permissions with labels and groups. */
export const GET = v1Route({}, async (_req, principal, ctx) => {
  requireMembersRead(principal);
  return {
    roles: await listRoles(ctx),
    permissions: PERMISSIONS.map((key) => ({ key, label: permissionLabel(key), group: permissionGroup(key) })),
  };
});
