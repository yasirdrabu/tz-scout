import { listStages } from '@/modules/routing';
import { can, requirePermission } from '@/modules/tenancy';
import { v1Route } from '../_lib/v1-route';

/** REV-E5: the workspace's stages in order, flow then exits, with the triggers to pick from. Anyone who reads accounts or their status. */
export const GET = v1Route({}, async (_req, principal, ctx) => {
  if (!can(principal, 'accounts:read')) requirePermission(principal, 'status:read');
  return listStages(ctx);
});
