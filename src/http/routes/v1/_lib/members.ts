import { can, requirePermission, type Principal } from '@/modules/tenancy';

/** The Members screen and roles matrix are open to `members:read` or `members:manage`, as the old page was. */
export function requireMembersRead(p: Principal): void {
  if (!can(p, 'members:manage')) requirePermission(p, 'members:read');
}
