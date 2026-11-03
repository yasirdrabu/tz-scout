import { accountNames } from '@/modules/accounts';
import { childSources, listFeedback, readSource, type FeedbackView } from '@/modules/intake';
import { listReasons } from '@/modules/routing';
import { requirePermission, userNames } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { parseIsoParam } from '../_lib/iso-date';
import { pageLimit } from '../_lib/pagination';
import { notFound } from '../_lib/path';
import { v1Route } from '../_lib/v1-route';

/** The line the Source page's Recent activity shows for a row (§11), from the reason label and who acted. */
function feedbackSummary(kind: string, reason: string | null, by: string | null, note: string | null): string {
  const tail = reason ? `: ${reason}` : '';
  switch (kind) {
    case 'sent_back':
      return `Sent back by ${by ?? 'a reviewer'}${tail}`;
    case 'declined_at_review':
      return `Not pursued at review${tail}`;
    case 'declined_by_seller':
      return `Declined by ${by ?? 'the seller'}${tail}`;
    case 'conflict_lost':
      return `Lost a conflict to ${note ?? 'another source'}`;
    case 'enrichment_declined':
      return 'Enrichment declined';
    case 'enrichment_expired':
      return 'Enrichment request expired';
    default:
      return kind;
  }
}

async function named(ctx: ModuleContext, rows: FeedbackView[]) {
  const reasons = new Map((await listReasons(ctx)).map((r) => [r.key, r.label]));
  const accounts = await accountNames(ctx, [...new Set(rows.map((r) => r.accountId))]);
  const people = await userNames(ctx, rows.map((r) => r.byUserId).filter((id): id is string => !!id));
  return rows.map((r) => {
    const reasonLabel = r.reasonKey ? (reasons.get(r.reasonKey) ?? r.reasonKey) : null;
    const byName = r.byUserId ? (people.get(r.byUserId) ?? null) : null;
    return { ...r, reasonLabel, byName, accountName: accounts.get(r.accountId) ?? null, summary: feedbackSummary(r.kind, reasonLabel, byName, r.note) };
  });
}

/**
 * SRC-E1-S4-AC2: what the principal's own source (and the sources below it) was told about its arrivals, newest first.
 * With `source_id` (`sources:manage`), the feed of that source and the sources below it, for its Source page.
 */
export const GET = v1Route({ permission: 'arrivals:read' }, async (req, principal, ctx) => {
  const url = new URL(req.url);
  const since = parseIsoParam(url.searchParams.get('since'), 'since');
  const sourceId = url.searchParams.get('source_id') || undefined;
  let sourceIds: string[] | undefined;
  if (sourceId) {
    requirePermission(principal, 'sources:manage');
    if (!(await readSource(ctx, sourceId))) throw notFound();
    sourceIds = [sourceId, ...(await childSources(ctx, [sourceId]))];
  }
  const page = await listFeedback(ctx, { since, cursor: url.searchParams.get('cursor') || undefined, limit: pageLimit(url), sourceIds });
  return { data: await named(ctx, page.data), nextCursor: page.nextCursor };
});
