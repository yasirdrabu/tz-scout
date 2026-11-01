import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { countAccounts, countAccountsBy, filterVisibleAccountIds, oldestCreatedAt, search, type SearchQuery, type SearchRow } from '@/modules/accounts';
import { companyChecks } from '@/modules/crm';
import { batchAccountIds, firstSources, sourceNames } from '@/modules/intake';
import { TIER_NAMES, TIERS, tierDetails } from '@/modules/scoring';
import { getPreference, setPreference, clearPreference } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import type { ReviewFlags } from '../contracts/types';
import { accountReview, statusChange } from '../db/schema';
import { columnProblems, columnsView, type ColumnChoice, type ColumnsView } from '../domain/columns';
import { leadOffer, loadNames } from './lookups';
import { loadStatuses, requirePerson, type StatusDef } from './review';

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
  /** Rows changed since, for the "{n} updates" bar (C14). */
  updatedSince?: Date;
  cursor?: string;
  limit?: number;
};

export type QueueRow = SearchRow & {
  reviewStatusLabel: string | null;
  reviewStatusColor: string | null;
  /** When the status was set, and by whom ("In review by {name}", C13); no name when Scout set it. */
  statusChangedAt: Date | null;
  statusChangedByName: string | null;
  insights: string | null;
  insightsBy: string | null;
  insightsAt: Date | null;
  /** What the CRM check found (Ruling 19); null when the account was never checked. */
  crm: { exists: boolean; ownerName: string | null; lifecycle: string } | null;
  /** The flag details: who declined and why, which source a new arrival came from ("New from <source>"). */
  flags: Omit<ReviewFlags, 'newFrom'> & { newFrom?: NonNullable<ReviewFlags['newFrom']> & { sourceName: string | null } };
  /** Conflicting facts and enrichment requests are R2; until then there are none. */
  conflictCount: number;
  enrichmentRequested: boolean;
  /** The source the account first came from, and the rest of its chain ("via"). */
  source: { sourceId: string; name: string; kind: string; via: string | null } | null;
  /** The practice of the best offer. */
  practiceName: string | null;
  /** The offer the row shows (Decision 5): someone's pick (`chosen`), else Scout's best offer. */
  leadOffer: { offerId: string; name: string | null; practiceId: string | null; practiceName: string | null; chosen: boolean } | null;
  /** "Was {old}" after a rescore moved the tier. */
  previousTier: string | null;
  /** The tier Scout scored, and who set the row's tier by hand, when and why (Decision 4). */
  scoredTier: string | null;
  tierSetByName: string | null;
  tierSetAt: Date | null;
  tierNote: string | null;
  warmIntro: { introducerName: string | null; points: number } | null;
};

/** The batch's accounts, or a 400 when there are more than the filter can take (it never quietly uses the first ones). */
async function batchFilterIds(ctx: ModuleContext, batchId: string): Promise<string[]> {
  const { accountIds, overflow } = await batchAccountIds(ctx, batchId);
  if (!overflow) return accountIds;
  const message = 'This batch has more than 1,000 accounts. Filter the queue another way.';
  throw new ScoutError({ slug: 'validation', status: 400, title: message, errors: [{ path: 'batch_id', message }] });
}

/** The accounts search query for the filters. Data limits apply inside accounts. */
async function queryFor(ctx: ModuleContext, f: QueueFilters, statuses: StatusDef[]): Promise<SearchQuery> {
  const q: SearchQuery = {
    practiceId: f.practiceId,
    bestOfferId: f.offerId,
    sourceId: f.sourceId,
    tier: f.tier,
    arrivedSince: f.arrivedSince,
    updatedSince: f.updatedSince,
    reviewFlags: f.flag ? [f.flag] : undefined,
    accountIds: f.batchId ? await batchFilterIds(ctx, f.batchId) : undefined,
  };
  if (f.statusKeys?.length) q.reviewStatusKeys = f.statusKeys;
  else {
    q.queueDefault = true;
    q.unreviewedStatusKeys = statuses.filter((s) => !s.countsAsReviewed).map((s) => s.key);
  }
  return q;
}

/** The review queue: priority first, then newest arrival, with everything a row shows (screens.md §2). */
export async function listQueue(ctx: ModuleContext, f: QueueFilters = {}): Promise<{ data: QueueRow[]; nextCursor: string | null }> {
  const statuses = await loadStatuses(ctx);
  const page = await search(ctx, { ...(await queryFor(ctx, f, statuses)), sort: 'queue', cursor: f.cursor, limit: f.limit });
  const ids = page.data.map((r) => r.accountId);
  const reviews = ids.length ? await ctx.tx.select().from(accountReview).where(and(eq(accountReview.tenantId, ctx.tenantId), inArray(accountReview.accountId, ids))) : [];
  const byId = new Map(reviews.map((r) => [r.accountId, r]));
  const status = new Map(statuses.map((s) => [s.key, s]));
  const newFromNames = await sourceNames(ctx, [...new Set(reviews.flatMap((r) => (r.flags.newFrom ? [r.flags.newFrom.sourceId] : [])))]);
  const checks = new Map((await companyChecks(ctx, ids)).map((c) => [c.accountId, c]));
  const sources = await firstSources(ctx, ids);
  const tiers = await tierDetails(ctx, ids);
  const names = await loadNames(ctx);
  return {
    data: page.data.map((r) => {
      const check = checks.get(r.accountId);
      const review = byId.get(r.accountId);
      const s = r.reviewStatusKey ? status.get(r.reviewStatusKey) : undefined;
      const { newFrom, ...flags } = review?.flags ?? {};
      const source = sources.get(r.accountId);
      const tier = tiers.get(r.accountId);
      return {
        ...r,
        reviewStatusLabel: s?.label ?? null,
        reviewStatusColor: s?.color ?? null,
        statusChangedAt: review?.statusChangedAt ?? null,
        statusChangedByName: names.person(review?.statusChangedBy),
        insights: review?.insights ?? null,
        insightsBy: review?.insightsBy ?? null,
        insightsAt: review?.insightsAt ?? null,
        crm: check ? { exists: check.exists, ownerName: check.ownerName, lifecycle: check.lifecycle } : null,
        flags: newFrom ? { ...flags, newFrom: { ...newFrom, sourceName: newFromNames.get(newFrom.sourceId) ?? null } } : flags,
        conflictCount: 0,
        enrichmentRequested: false,
        source: source ? { sourceId: source.sourceId, name: source.name, kind: source.kind, via: source.via } : null,
        practiceName: names.practice(r.practiceId),
        leadOffer: leadOffer(names, review?.leadOfferOverrideId ?? null, r.bestOfferId),
        previousTier: tier?.previousTier ?? null,
        scoredTier: tier?.scoredTier ?? r.tier,
        tierSetByName: names.person(tier?.tierSetBy),
        tierSetAt: tier?.tierSetAt ?? null,
        tierNote: tier?.tierNote ?? null,
        warmIntro: tier?.warmIntro ?? null,
      };
    }),
    nextCursor: page.nextCursor,
  };
}

/** How many accounts the queue holds for the same filters and data limits (REV-E1-S1-AC4). */
export async function countQueue(ctx: ModuleContext, f: QueueFilters = {}): Promise<number> {
  return countAccounts(ctx, await queryFor(ctx, f, await loadStatuses(ctx)));
}

export type FacetOption = { value: string; label: string; count: number };

export type QueueFacets = {
  total: number;
  /** "Oldest arrived {age} ago": the earliest arrival in the filtered queue. */
  oldestArrivedAt: Date | null;
  /** "Last account reviewed {when}": the latest move to a status that counts as reviewed. */
  lastReviewedAt: Date | null;
  /** Every tier, best first, with its name from scoring. */
  tiers: FacetOption[];
  practices: FacetOption[];
  offers: FacetOption[];
  sources: FacetOption[];
  /** Every live status, in order, counted over all statuses (not just the default view). */
  statuses: (FacetOption & { color: string })[];
};

const options = (counts: Map<string | null, number>, label: (id: string) => string | null, keep?: string): FacetOption[] =>
  [...counts.entries()]
    .filter((e): e is [string, number] => e[0] !== null)
    .flatMap(([value, count]) => {
      const name = label(value);
      return name ? [{ value, label: name, count }] : [];
    })
    .concat(keep && !counts.has(keep) && label(keep) ? [{ value: keep, label: label(keep)!, count: 0 }] : [])
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

/**
 * Tier tab counts and filter option counts for the queue (screens.md §2): each facet is counted with
 * every other filter applied and its own left out, under the caller's data limit. The status facet
 * counts every status, so a filter for a status outside the default view shows its count too.
 */
export async function queueFacets(ctx: ModuleContext, f: QueueFilters = {}): Promise<QueueFacets> {
  const statuses = await loadStatuses(ctx);
  const without = async (drop: Partial<Record<keyof QueueFilters, undefined>>) => queryFor(ctx, { ...f, ...drop }, statuses);
  const names = await loadNames(ctx);
  const tierCounts = await countAccountsBy(ctx, await without({ tier: undefined }), 'tier');
  const practiceCounts = await countAccountsBy(ctx, await without({ practiceId: undefined }), 'practice');
  const offerCounts = await countAccountsBy(ctx, await without({ offerId: undefined }), 'offer');
  const sourceCounts = await countAccountsBy(ctx, await without({ sourceId: undefined }), 'source');
  const live = statuses.filter((s) => !s.archivedAt);
  const statusCounts = await countAccountsBy(ctx, await queryFor(ctx, { ...f, statusKeys: statuses.map((s) => s.key) }, statuses), 'review_status');
  const sourceLabels = await sourceNames(ctx, [...sourceCounts.keys()].filter((k): k is string => k !== null));
  const base = await queryFor(ctx, f, statuses);
  const reviewedKeys = statuses.filter((s) => s.countsAsReviewed).map((s) => s.key);
  const lastReviewedAt = await lastReviewed(ctx, reviewedKeys);
  return {
    total: await countAccounts(ctx, base),
    oldestArrivedAt: await oldestCreatedAt(ctx, base),
    lastReviewedAt,
    tiers: [...TIERS].reverse().map((t) => ({ value: t, label: TIER_NAMES[t], count: tierCounts.get(t) ?? 0 })),
    practices: options(practiceCounts, (id) => names.practice(id), f.practiceId),
    offers: options(offerCounts, (id) => names.offer(id)?.name ?? null, f.offerId),
    sources: options(sourceCounts, (id) => sourceLabels.get(id) ?? null, f.sourceId),
    statuses: live.map((s) => ({ value: s.key, label: s.label, color: s.color, count: statusCounts.get(s.key) ?? 0 })),
  };
}

const REVIEWED_PAGE = 200;
const REVIEWED_PAGES = 5;

/**
 * "Last account reviewed {when}" over the accounts the caller can see: the newest move to a status that
 * counts as reviewed, read newest first a page at a time. Null when none is found in the pages read.
 */
async function lastReviewed(ctx: ModuleContext, reviewedKeys: string[]): Promise<Date | null> {
  if (reviewedKeys.length === 0) return null;
  let before: { at: Date; id: string } | null = null;
  for (let page = 0; page < REVIEWED_PAGES; page++) {
    const rows: { accountId: string; at: Date; id: string }[] = await ctx.tx
      .select({ accountId: statusChange.accountId, at: statusChange.at, id: statusChange.id })
      .from(statusChange)
      .where(
        and(
          eq(statusChange.tenantId, ctx.tenantId),
          inArray(statusChange.toKey, reviewedKeys),
          before ? sql`(${statusChange.at}, ${statusChange.id}) < (${before.at.toISOString()}::timestamptz, ${before.id})` : undefined,
        ),
      )
      .orderBy(desc(statusChange.at), desc(statusChange.id))
      .limit(REVIEWED_PAGE);
    if (rows.length === 0) return null;
    const visible = new Set(await filterVisibleAccountIds(ctx, [...new Set(rows.map((r) => r.accountId))]));
    const hit = rows.find((r) => visible.has(r.accountId));
    if (hit) return hit.at;
    before = rows[rows.length - 1]!;
  }
  return null;
}

const COLUMNS_KEY = 'review_queue_columns';

/** The caller's review queue columns ("Saved for you only."), or the default. */
export async function getQueueColumns(ctx: ModuleContext): Promise<ColumnsView> {
  requirePerson(ctx);
  return columnsView(await getPreference(ctx, COLUMNS_KEY));
}

/** Saves the caller's columns: every column once, in order, each shown or hidden. */
export async function setQueueColumns(ctx: ModuleContext, columns: ColumnChoice[]): Promise<ColumnsView> {
  requirePerson(ctx);
  const problems = columnProblems(columns);
  if (problems.length > 0) throw new ScoutError({ slug: 'validation', status: 400, title: problems[0]!, errors: [{ path: 'columns', message: problems[0]! }] });
  await setPreference(ctx, COLUMNS_KEY, columns.map((c) => ({ key: c.key, visible: c.visible })));
  return columnsView(columns);
}

/** `Reset`: back to the default columns. */
export async function resetQueueColumns(ctx: ModuleContext): Promise<ColumnsView> {
  requirePerson(ctx);
  await clearPreference(ctx, COLUMNS_KEY);
  return columnsView(null);
}
