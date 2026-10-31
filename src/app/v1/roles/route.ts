import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, permissionGroup, permissionLabel } from '@/modules/tenancy';
import { requireMembersRead } from '../_lib/members';
import { v1Route } from '../_lib/v1-route';

export const dynamic = 'force-dynamic';

// The roles and permissions matrix, read only until the roles plan (Decision 17).
export const GET = v1Route({}, async (_req, principal) => {
  requireMembersRead(principal);
  return {
    roles: ROLES.map((role) => ({ role, permissions: ROLE_PERMISSIONS[role] })),
    permissions: PERMISSIONS.map((key) => ({ key, label: permissionLabel(key), group: permissionGroup(key) })),
  };
});
