import { listAssignments } from '@/modules/routing';
import { pageLimit } from '../../../_lib/pagination';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

export const dynamic = 'force-dynamic';

/** The assignments of one account, newest first. A hidden or missing account is a 404. */
export const GET = v1Route({ permission: 'assign:act' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const url = new URL(req.url);
  return listAssignments(ctx, { accountId: id, status: url.searchParams.get('status') || undefined, cursor: url.searchParams.get('cursor') || undefined, limit: pageLimit(url) });
});
