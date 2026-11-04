import { firstArrivals } from '@/modules/intake';
import { listAccounts } from '@/modules/routing';
import { planFields } from '../_lib/next-step';
import { pageLimit } from '../_lib/pagination';
import { v1Route } from '../_lib/v1-route';
import { accountFilters } from './filters';

/**
 * Accounts under the caller's data limit (ACC-E8, All accounts §8), with names, CRM facts and the `total` for the
 * filters. Each row carries `next_step` and `playbook_name` from its open plan (null without one). With `source_id`,
 * each row adds `first_arrival`: how it first came in through that source or one below it.
 */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  const filters = accountFilters(url);
  const page = await listAccounts(ctx, { ...filters, cursor: url.searchParams.get('cursor') || undefined, limit: pageLimit(url) });
  const plans = await planFields(ctx, page.data.map((r) => r.accountId));
  const data = page.data.map((r) => ({ ...r, nextStep: plans.get(r.accountId)?.nextStep ?? null, playbookName: plans.get(r.accountId)?.playbookName ?? null }));
  if (!filters.sourceId) return { ...page, data };
  const first = await firstArrivals(ctx, data.map((r) => r.accountId), filters.sourceId);
  return { ...page, data: data.map((r) => ({ ...r, firstArrival: first.get(r.accountId) ?? null })) };
});
