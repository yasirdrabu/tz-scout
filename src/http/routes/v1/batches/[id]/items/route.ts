import { ITEM_STATUSES, listBatchItemRows, type ItemStatus } from '@/modules/intake';
import { listStatuses } from '@/modules/routing';
import { TIER_NAMES, type Tier } from '@/modules/scoring';
import { can } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { withoutContacts } from '../../../_lib/intake';
import { pageLimit } from '../../../_lib/pagination';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/**
 * The batch's rows (§14), newest first, by `status` (`all`, `waiting`, `resolved`, `rejected`), with `total`, the
 * company, the account's name, priority, tier and review status (null where the caller may not see the account) and
 * the outcome words (Ruling 9).
 */
export const GET = v1Route({ permission: 'arrivals:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'batches');
  if (action) throw notFound();
  const url = new URL(req.url);
  const status = (url.searchParams.get('status') || 'all') as ItemStatus;
  if (!ITEM_STATUSES.includes(status)) {
    const title = 'Pick all, waiting, resolved or rejected.';
    throw new ScoutError({ slug: 'validation', status: 400, title, errors: [{ path: 'status', message: title }] });
  }
  const page = await listBatchItemRows(ctx, id, { status, cursor: url.searchParams.get('cursor') || undefined, limit: pageLimit(url) });
  if (!page) throw notFound();
  const labels = new Map((await listStatuses(ctx)).map((s) => [s.key, s.label]));
  const body = {
    ...page,
    data: page.data.map((r) => ({
      ...r,
      tierLabel: r.tier ? (TIER_NAMES[r.tier as Tier] ?? r.tier) : null,
      reviewStatusLabel: r.reviewStatusKey ? (labels.get(r.reviewStatusKey) ?? null) : null,
      duplicateCandidates: ((r.duplicateCandidates as { accountId: string; name: string; domain: string | null }[] | null) ?? []).map((c) => ({
        accountId: c.accountId,
        name: c.name,
        domain: c.domain,
      })),
    })),
  };
  return can(principal, 'people:read') ? body : withoutContacts(body);
});
