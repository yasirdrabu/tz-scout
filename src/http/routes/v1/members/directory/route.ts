import { can, memberDirectory, requirePermission } from '@/modules/tenancy';
import { v1Route } from '../../_lib/v1-route';

/** Who can pick a person (an owner, "Sent by", a practice lead) without the Members screen. */
const DIRECTORY_PERMISSIONS = ['sources:manage', 'imports:run', 'assign:act', 'members:read'] as const;

/** Active members by name, `{ user_id, name }` only. */
export const GET = v1Route({}, async (_req, principal, ctx) => {
  if (!DIRECTORY_PERMISSIONS.some((p) => can(principal, p))) requirePermission(principal, 'members:read');
  return { data: await memberDirectory(ctx) };
});
