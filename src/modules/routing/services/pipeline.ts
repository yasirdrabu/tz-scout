import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { countAccounts, countAccountsBy, filterVisibleAccountIds, search, type SearchQuery, type SearchRow, type SearchSort } from '@/modules/accounts';
import { crmFacts, type AccountCrmFacts } from '@/modules/crm';
import { firstSources, sourceNames } from '@/modules/intake';
import { TIER_NAMES, type Tier } from '@/modules/scoring';
import { members, tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import type { Stage } from '../contracts/types';
import { accountReview, stageChange } from '../db/schema';
import { toCsv } from '../domain/csv';
import { EXIT_STAGES, PIPELINE_STAGES, STAGE_LABELS } from '../domain/stages';
import { leadOffer, loadNames } from './lookups';
import { loadStatuses, type StatusDef } from './review';
import type { FacetOption } from './queue';

/** All accounts' filters (screens.md §8). `stages` takes pipeline stages, exits and `other`. */
export type AccountListFilters = {
  text?: string;
  domain?: string;
  tier?: string;
  practiceId?: string;
  offerId?: string;
  sourceId?: string;
  stages?: string[];
  /** A user id, or `me` for the caller. */
  ownerUserId?: string;
  unassigned?: boolean;
  reviewStatusKeys?: string[];
  sort?: SearchSort;
  cursor?: string;
  limit?: number;
};

export type AccountListRow = SearchRow & {
  stageLabel: string | null;
  tierLabel: string | null;
  reviewStatusLabel: string | null;
  ownerName: string | null;
  practiceName: string | null;
  leadOffer: { offerId: string; name: string | null; practiceId: string | null; practiceName: string | null; chosen: boolean } | null;
  source: { sourceId: string; name: string; kind: string; via: string | null } | null;
  lastActivity: AccountCrmFacts['lastActivity'];
  value: AccountCrmFacts['value'];
  /** Playbook steps are R2. */
  nextStep: null;
};

/** The "Other" tab: exits, plus accounts sent back to their source (they keep an earlier stage). */
const OTHER = 'other';
const sentBackKeys = (statuses: StatusDef[]) => statuses.filter((s) => s.returnsToSource).map((s) => s.key);

function ownerFilter(ctx: ModuleContext, ownerUserId: string | undefined): string | undefined {
  if (ownerUserId !== 'me') return ownerUserId;
  const me = ctx.access?.userId;
  if (!me) throw new ScoutError({ slug: 'validation', status: 400, title: 'Only a person has accounts of their own.', errors: [{ path: 'owner_user_id', message: 'Only a person has accounts of their own.' }] });
  return me;
}

function queryFor(ctx: ModuleContext, f: AccountListFilters, statuses: StatusDef[]): SearchQuery {
  const q: SearchQuery = {
    text: f.text,
    domain: f.domain,
    tier: f.tier,
    practiceId: f.practiceId,
    bestOfferId: f.offerId,
    sourceId: f.sourceId,
    ownerUserId: ownerFilter(ctx, f.ownerUserId),
    unassigned: f.unassigned || undefined,
    reviewStatusKeys: f.reviewStatusKeys?.length ? f.reviewStatusKeys : undefined,
  };
  const stages = f.stages ?? [];
  if (stages.includes(OTHER)) q.stageOrStatus = { stages: [...EXIT_STAGES, ...stages.filter((s) => s !== OTHER)], reviewStatusKeys: sentBackKeys(statuses) };
  else if (stages.length) {
    q.stages = stages;
    // A sent-back account sits in the Other tab, not in the stage it kept.
    if (stages.every((s) => (PIPELINE_STAGES as readonly string[]).includes(s))) q.notReviewStatusKeys = sentBackKeys(statuses);
  }
  return q;
}

/** All accounts (screens.md §8): rows under the data limit, with names, CRM facts and the page's total. */
export async function listAccounts(ctx: ModuleContext, f: AccountListFilters = {}): Promise<{ data: AccountListRow[]; nextCursor: string | null; total: number }> {
  const statuses = await loadStatuses(ctx);
  const q = queryFor(ctx, f, statuses);
  const page = await search(ctx, { ...q, sort: f.sort, cursor: f.cursor, limit: f.limit });
  const ids = page.data.map((r) => r.accountId);
  const names = await loadNames(ctx);
  const labels = new Map(statuses.map((s) => [s.key, s.label]));
  const overrides = ids.length
    ? new Map(
        (
          await ctx.tx
            .select({ accountId: accountReview.accountId, leadOfferOverrideId: accountReview.leadOfferOverrideId })
            .from(accountReview)
            .where(and(eq(accountReview.tenantId, ctx.tenantId), inArray(accountReview.accountId, ids)))
        ).map((r) => [r.accountId, r.leadOfferOverrideId]),
      )
    : new Map<string, string | null>();
  const sources = await firstSources(ctx, ids);
  const crm = await crmFacts(ctx, ids);
  return {
    data: page.data.map((r) => {
      const source = sources.get(r.accountId);
      const facts = crm.get(r.accountId);
      return {
        ...r,
        stageLabel: r.stage ? (STAGE_LABELS[r.stage as Stage] ?? r.stage) : null,
        tierLabel: r.tier ? (TIER_NAMES[r.tier as Tier] ?? r.tier) : null,
        reviewStatusLabel: r.reviewStatusKey ? (labels.get(r.reviewStatusKey) ?? null) : null,
        ownerName: names.person(r.ownerUserId),
        practiceName: names.practice(r.practiceId),
        leadOffer: leadOffer(names, overrides.get(r.accountId) ?? null, r.bestOfferId),
        source: source ? { sourceId: source.sourceId, name: source.name, kind: source.kind, via: source.via } : null,
        lastActivity: facts?.lastActivity ?? null,
        value: facts?.value ?? null,
        nextStep: null,
      };
    }),
    nextCursor: page.nextCursor,
    total: await countAccounts(ctx, q),
  };
}

export type AccountFacets = {
  /** Every account the filters match, any stage ("{n} accounts across every stage"). */
  total: number;
  /** "{won} won this year": accounts that reached Won since 1 January in the tenant's timezone, under the data limit. */
  wonThisYear: number;
  /** One tab per pipeline stage in order, then `other`. */
  stages: { key: string; label: string; count: number }[];
  /** Sellers and "Unassigned". */
  owners: FacetOption[];
  practices: FacetOption[];
  sources: FacetOption[];
  /** Tiers with their names (C6), counted with the tier filter left out. */
  tiers: FacetOption[];
};

const facetOptions = (counts: Map<string | null, number>, label: (id: string) => string | null, extra: string[] = []): FacetOption[] => {
  const keys = new Set([...[...counts.keys()].filter((k): k is string => k !== null), ...extra]);
  return [...keys]
    .flatMap((value) => {
      const name = label(value);
      return name ? [{ value, label: name, count: counts.get(value) ?? 0 }] : [];
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
};

/** Stage tab counts and filter option counts for All accounts, each counted with its own filter left out. */
export async function accountFacets(ctx: ModuleContext, f: AccountListFilters = {}): Promise<AccountFacets> {
  const statuses = await loadStatuses(ctx);
  const names = await loadNames(ctx);
  const anyStage = queryFor(ctx, { ...f, stages: undefined }, statuses);
  const stageCounts = await countAccountsBy(ctx, { ...anyStage, notReviewStatusKeys: sentBackKeys(statuses) }, 'stage');
  const other = await countAccounts(ctx, { ...anyStage, stageOrStatus: { stages: [...EXIT_STAGES], reviewStatusKeys: sentBackKeys(statuses) } });
  const ownerCounts = await countAccountsBy(ctx, queryFor(ctx, { ...f, ownerUserId: undefined, unassigned: undefined }, statuses), 'owner');
  const practiceCounts = await countAccountsBy(ctx, queryFor(ctx, { ...f, practiceId: undefined }, statuses), 'practice');
  const sourceCounts = await countAccountsBy(ctx, queryFor(ctx, { ...f, sourceId: undefined }, statuses), 'source');
  const tierCounts = await countAccountsBy(ctx, queryFor(ctx, { ...f, tier: undefined }, statuses), 'tier');
  const sellers = (await members(ctx, { permission: 'assignments:respond' })).filter((m) => m.status === 'active').map((m) => m.userId);
  const sourceLabels = await sourceNames(ctx, [...sourceCounts.keys()].filter((k): k is string => k !== null));
  const owners = facetOptions(ownerCounts, (id) => names.person(id), sellers);
  return {
    total: await countAccounts(ctx, anyStage),
    wonThisYear: await wonThisYear(ctx),
    stages: [
      ...PIPELINE_STAGES.map((s) => ({ key: s, label: STAGE_LABELS[s], count: stageCounts.get(s) ?? 0 })),
      { key: OTHER, label: 'Other', count: other },
    ],
    owners: [...owners, { value: 'unassigned', label: 'Unassigned', count: ownerCounts.get(null) ?? 0 }],
    practices: facetOptions(practiceCounts, (id) => names.practice(id)),
    sources: facetOptions(sourceCounts, (id) => sourceLabels.get(id) ?? null),
    tiers: (Object.keys(TIER_NAMES) as Tier[]).map((t) => ({ value: t, label: TIER_NAMES[t], count: tierCounts.get(t) ?? 0 })),
  };
}

async function wonThisYear(ctx: ModuleContext): Promise<number> {
  const tz = await tenantTimezone(ctx);
  const rows = await ctx.tx
    .selectDistinct({ accountId: stageChange.accountId })
    .from(stageChange)
    .where(and(eq(stageChange.tenantId, ctx.tenantId), eq(stageChange.toStage, 'won'), gte(stageChange.at, sql`date_trunc('year', now() at time zone ${tz}) at time zone ${tz}`)));
  return (await filterVisibleAccountIds(ctx, rows.map((r) => r.accountId))).length;
}

/** The most rows one export writes. */
export const MAX_EXPORT_ROWS = 10_000;

const HEADER = ['Account', 'Domain', 'Industry', 'City', 'State', 'Stage', 'Review status', 'Owner', 'Best offer', 'Practice', 'Priority', 'Tier', 'Source', 'Last activity', 'Last activity at', 'Value', 'Currency', 'Value kind'];

/** `Export CSV`: the same rows the list would show for the filters, in its order, up to 10,000. */
export async function exportAccounts(ctx: ModuleContext, f: AccountListFilters = {}): Promise<{ csv: string; count: number }> {
  const rows: AccountListRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await listAccounts(ctx, { ...f, cursor, limit: 200 });
    rows.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && rows.length < MAX_EXPORT_ROWS);
  const kept = rows.slice(0, MAX_EXPORT_ROWS);
  const csv = toCsv(
    HEADER,
    kept.map((r) => [
      r.name,
      r.domain,
      r.industry,
      r.hqCity,
      r.hqState,
      r.stageLabel,
      r.reviewStatusLabel,
      r.ownerName ?? 'Unassigned',
      r.leadOffer?.name,
      r.leadOffer?.practiceName ?? r.practiceName,
      r.priority,
      r.tier ? (TIER_NAMES[r.tier as Tier] ?? r.tier) : null,
      r.source?.name,
      r.lastActivity?.kind,
      r.lastActivity?.at.toISOString(),
      r.value?.amountCents === null || r.value?.amountCents === undefined ? null : (r.value.amountCents / 100).toFixed(2),
      r.value?.currency,
      r.value ? (r.value.kind === 'won' ? 'Won' : 'Open deal') : null,
    ]),
  );
  return { csv, count: kept.length };
}
