import { listQueue } from '@/modules/routing';
import { pageLimit } from '../_lib/pagination';
import { v1Route } from '../_lib/v1-route';
import { queueFilters } from './filters';

export const dynamic = 'force-dynamic';

/** REV-E1-S1: the review queue, data-scoped. Without `status` it is the default view (accounts waiting on a leader). */
export const GET = v1Route({ permission: 'review:act' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  return listQueue(ctx, { ...queueFilters(url), cursor: url.searchParams.get('cursor') || undefined, limit: pageLimit(url) });
});
