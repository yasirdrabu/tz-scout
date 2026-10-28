import { listAssignments } from '@/modules/routing';
import { can, requirePermission } from '@/modules/tenancy';
import { pageLimit } from '../_lib/pagination';
import { v1Route } from '../_lib/v1-route';

export const dynamic = 'force-dynamic';

/**
 * REV-E2-S2: `mine` is the caller's own assignments (`assignments:respond`). Without it the list crosses
 * accounts and shows leaders' notes and decline reasons, so it needs `assign:act` or `review:act`.
 * A page can be short with a `next_cursor`; follow it.
 */
export const GET = v1Route({}, async (req, principal, ctx) => {
  const url = new URL(req.url);
  const mine = url.searchParams.has('mine') && url.searchParams.get('mine') !== 'false';
  if (mine) requirePermission(principal, 'assignments:respond');
  else if (!can(principal, 'assign:act')) requirePermission(principal, 'review:act');
  return listAssignments(ctx, { mine, status: url.searchParams.get('status') || undefined, cursor: url.searchParams.get('cursor') || undefined, limit: pageLimit(url) });
});
