import { listAccounts } from '@/modules/routing';
import { pageLimit } from '../_lib/pagination';
import { v1Route } from '../_lib/v1-route';
import { accountFilters } from './filters';

/** Accounts under the caller's data limit (ACC-E8, All accounts §8), with names, CRM facts and the `total` for the filters. */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  return listAccounts(ctx, { ...accountFilters(url), cursor: url.searchParams.get('cursor') || undefined, limit: pageLimit(url) });
});
