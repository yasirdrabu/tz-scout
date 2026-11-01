import { listBatches } from '@/modules/crm';
import { pageLimit } from '../_lib/pagination';
import { v1Route } from '../_lib/v1-route';

/** Newest first. The cursor is the last batch's id. */
export const GET = v1Route({ permission: 'crm:push', peopleOnly: true }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  const { items, nextCursor } = await listBatches(ctx, { limit: pageLimit(url), ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}) });
  return { data: items, nextCursor };
});
