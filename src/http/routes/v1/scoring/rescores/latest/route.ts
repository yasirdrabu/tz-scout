import { latestRescore } from '@/modules/scoring';
import { can, requirePermission } from '@/modules/tenancy';
import { v1Route } from '../../../_lib/v1-route';

/** The review queue's rescore progress (Ruling 12): the newest run started in the last 24 hours, or `data: null`. `review:act` or `scoring:manage`. */
export const GET = v1Route({}, async (_req, principal, ctx) => {
  if (!can(principal, 'review:act')) requirePermission(principal, 'scoring:manage');
  return { data: await latestRescore(ctx) };
});
