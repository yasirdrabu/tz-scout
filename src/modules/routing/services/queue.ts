import { and, eq, inArray } from 'drizzle-orm';
import { countAccounts, search, type SearchQuery, type SearchRow } from '@/modules/accounts';
import { batchAccountIds } from '@/modules/intake';
import type { ModuleContext } from '@/platform/context';
import type { ReviewFlags } from '../contracts/types';
import { accountReview } from '../db/schema';
import { loadStatuses, type StatusDef } from './review';

/** The queue filters (REV-E1). With no status filter the queue shows its default view (Ruling 15). */
export type QueueFilters = {
  statusKeys?: string[];
  practiceId?: string;
  offerId?: string;
  /** Any level of the chain: person, agent or vendor. */
  sourceId?: string;
  batchId?: string;
  tier?: string;
  /** One of the review flags, such as `declined_by_seller`. */
  flag?: string;
  arrivedSince?: Date;
  cursor?: string;
  limit?: number;
};

export type QueueRow = SearchRow & {
  reviewStatusLabel: string | null;
  insights: string | null;
  insightsBy: string | null;
  insightsAt: Date | null;
  /** The flag details: who declined and why, where a new arrival came from. */
  flags: ReviewFlags;
};

/** The accounts search query for the filters. Data limits apply inside accounts. */
async function queryFor(ctx: ModuleContext, f: QueueFilters, statuses: StatusDef[]): Promise<SearchQuery> {
  const q: SearchQuery = {
    practiceId: f.practiceId,
    bestOfferId: f.offerId,
    sourceId: f.sourceId,
    tier: f.tier,
    arrivedSince: f.arrivedSince,
    reviewFlags: f.flag ? [f.flag] : undefined,
    accountIds: f.batchId ? await batchAccountIds(ctx, f.batchId) : undefined,
  };
  if (f.statusKeys?.length) q.reviewStatusKeys = f.statusKeys;
  else {
    q.queueDefault = true;
    q.unreviewedStatusKeys = statuses.filter((s) => !s.countsAsReviewed).map((s) => s.key);
  }
  return q;
}

/** The review queue: priority first, then newest arrival, with insights and flag details for the page. */
export async function listQueue(ctx: ModuleContext, f: QueueFilters = {}): Promise<{ data: QueueRow[]; nextCursor: string | null }> {
  const statuses = await loadStatuses(ctx);
  const page = await search(ctx, { ...(await queryFor(ctx, f, statuses)), sort: 'queue', cursor: f.cursor, limit: f.limit });
  const ids = page.data.map((r) => r.accountId);
  const reviews = ids.length
    ? await ctx.tx
        .select({ accountId: accountReview.accountId, insights: accountReview.insights, insightsBy: accountReview.insightsBy, insightsAt: accountReview.insightsAt, flags: accountReview.flags })
        .from(accountReview)
        .where(and(eq(accountReview.tenantId, ctx.tenantId), inArray(accountReview.accountId, ids)))
    : [];
  const byId = new Map(reviews.map((r) => [r.accountId, r]));
  const labels = new Map(statuses.map((s) => [s.key, s.label]));
  return {
    data: page.data.map((r) => {
      const review = byId.get(r.accountId);
      return {
        ...r,
        reviewStatusLabel: r.reviewStatusKey ? (labels.get(r.reviewStatusKey) ?? null) : null,
        insights: review?.insights ?? null,
        insightsBy: review?.insightsBy ?? null,
        insightsAt: review?.insightsAt ?? null,
        flags: review?.flags ?? {},
      };
    }),
    nextCursor: page.nextCursor,
  };
}

/** How many accounts the queue holds for the same filters and data limits (REV-E1-S1-AC4). */
export async function countQueue(ctx: ModuleContext, f: QueueFilters = {}): Promise<number> {
  return countAccounts(ctx, await queryFor(ctx, f, await loadStatuses(ctx)));
}
