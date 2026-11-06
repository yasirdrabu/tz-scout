import { accountNames, filterVisibleAccountIds } from '@/modules/accounts';
import { batchNames, sourceTree, type SourceKind } from '@/modules/intake';
import { listOffers } from '@/modules/offers';
import { tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { costStatus, insight, lostAt, ratio, reachedIndex, rollUp, spendBySource, stageCounts, stepPct, type CostStatus, type StageDef } from '../domain/funnel';
import { periodRange, type PeriodKey } from '../domain/period';
import { getTarget, spendLines, spendOf, stageDefs, sumOf } from './costs-by-source';
import { journeysUpdatedAt, loadJourneys, type Journey } from './journeys';

export const PERIODS: PeriodKey[] = ['30d', '90d', 'quarter', 'year'];
export const CHOOSE_PERIOD = 'Choose a period: 30d, 90d, quarter or year.';

/** The cohort filters (Ruling 5). */
export type FunnelFilters = { period: PeriodKey; practiceId?: string; offerId?: string; batchId?: string };

/** `spend`: whether the caller may see spend (`costs:read`); without it every spend field is null (Ruling 10). */
export type FunnelOpts = { spend: boolean; now?: Date };

/** The `period` query value, `90d` when absent; anything else is a 400. */
export function parsePeriod(value: string | null): PeriodKey {
  if (value === null || value === '') return '90d';
  if (!PERIODS.includes(value as PeriodKey)) {
    throw new ScoutError({ slug: 'validation', status: 400, title: CHOOSE_PERIOD, errors: [{ path: 'period', message: CHOOSE_PERIOD }] });
  }
  return value as PeriodKey;
}

export type FunnelRow = {
  sourceId: string;
  name: string;
  kind: SourceKind;
  counts: number[];
  stepPct: (number | null)[];
  costPerAccountCents: (number | null)[] | null;
  spendCents: number | null;
  costPerWonCents: number | null;
  status: CostStatus | null;
  winRatePct: number;
};

export type FunnelView = {
  period: { key: PeriodKey; from: string; to: string };
  stages: { key: string; name: string }[];
  targetCostPerWonCents: number | null;
  totals: { sent: number; sources: number; won: number; wonPct: number | null; spendCents: number | null; costPerWonCents: number | null };
  rows: FunnelRow[];
  sharedSpendCents: number | null;
  updatedAt: Date | null;
};

type Basis = {
  period: FunnelView['period'];
  flow: StageDef[];
  cohort: Journey[];
  tree: Map<string, string[]>;
  sources: Awaited<ReturnType<typeof sourceTree>>['sources'];
  bySource: Map<string, number>;
  totalSpend: number;
  target: number | null;
  spend: boolean;
};

const firstSources = (js: Journey[]) => new Map(js.map((j) => [j.accountId, j.firstSourceId]));

/** The journeys the caller can see (data limits narrow accounts only, never spend). */
async function visible(ctx: ModuleContext, js: Journey[]): Promise<Journey[]> {
  const ok = new Set(await filterVisibleAccountIds(ctx, js.map((j) => j.accountId)));
  return js.filter((j) => ok.has(j.accountId));
}

/** The period's cohort under the filters and the caller's data limit, and the period's spend per source. */
async function basis(ctx: ModuleContext, f: FunnelFilters, opts: FunnelOpts): Promise<Basis> {
  const range = periodRange(f.period, opts.now ?? new Date(), await tenantTimezone(ctx));
  const flow = (await stageDefs(ctx)).filter((s) => s.kind === 'flow');
  const all = await loadJourneys(ctx);
  const picked = all.filter(
    (j) =>
      j.arrivedAt >= range.from &&
      j.arrivedAt <= range.to &&
      (!f.practiceId || j.practiceId === f.practiceId) &&
      (!f.offerId || j.offerId === f.offerId) &&
      (!f.batchId || j.firstBatchId === f.batchId),
  );
  const lines = await spendLines(ctx, range);
  const { tree, sources } = await sourceTree(ctx);
  return {
    period: { key: f.period, from: range.fromDay, to: range.toDay },
    flow,
    cohort: await visible(ctx, picked),
    tree,
    sources,
    bySource: spendBySource(lines, firstSources(all)).bySource,
    totalSpend: sumOf(lines),
    target: await getTarget(ctx),
    spend: opts.spend,
  };
}

const wonCount = (counts: number[]) => counts[counts.length - 1] ?? 0;

/** One source's numbers, its children rolled up (Ruling 4). */
function rowOf(b: Basis, sourceId: string): FunnelRow & { journeys: Journey[] } {
  const s = b.sources.get(sourceId)!;
  const below = rollUp(sourceId, b.tree);
  const journeys = b.cohort.filter((j) => below.has(j.firstSourceId));
  const counts = stageCounts(journeys, b.flow);
  const sent = journeys.length;
  const won = wonCount(counts);
  const spend = spendOf(below, b.bySource);
  const perWon = ratio(spend, won);
  return {
    sourceId,
    name: s.name,
    kind: s.kind,
    counts,
    stepPct: stepPct(counts),
    costPerAccountCents: b.spend ? counts.map((c) => ratio(spend, c)) : null,
    spendCents: b.spend ? spend : null,
    costPerWonCents: b.spend ? perWon : null,
    status: b.spend ? costStatus(sent, won, perWon, b.target) : null,
    winRatePct: ratio(won * 100, sent) ?? 0,
    journeys,
  };
}

/** The table rows: top-level sources (not removed) with an account in the cohort, by sent then name. */
function rowsOf(b: Basis): FunnelRow[] {
  const rows: FunnelRow[] = [];
  for (const [id, s] of b.sources) {
    if (s.parentId || s.status === 'removed') continue;
    const { journeys, ...row } = rowOf(b, id);
    if (journeys.length > 0) rows.push(row);
  }
  return rows.sort((x, y) => y.counts[0]! - x.counts[0]! || x.name.localeCompare(y.name));
}

/** `GET /analytics/funnel` (Ruling 10). */
export async function funnel(ctx: ModuleContext, f: FunnelFilters, opts: FunnelOpts): Promise<FunnelView> {
  const b = await basis(ctx, f, opts);
  const rows = rowsOf(b);
  const sent = b.cohort.length;
  const won = wonCount(stageCounts(b.cohort, b.flow));
  const inRows = rows.reduce((s, r) => s + (r.spendCents ?? 0), 0);
  return {
    period: b.period,
    stages: b.flow.map((s) => ({ key: s.key, name: s.name })),
    targetCostPerWonCents: b.spend ? b.target : null,
    totals: {
      sent,
      sources: rows.length,
      won,
      wonPct: ratio(won * 100, sent),
      spendCents: b.spend ? b.totalSpend : null,
      costPerWonCents: b.spend ? ratio(b.totalSpend, won) : null,
    },
    rows,
    // Whatever no row shows: lines with no source or account, and spend under sources with no row.
    sharedSpendCents: b.spend ? b.totalSpend - inRows : null,
    updatedAt: await journeysUpdatedAt(ctx),
  };
}

export type SourcePerformance = {
  source: { id: string; name: string; kind: SourceKind };
  period: FunnelView['period'];
  rank: number | null;
  of: number;
  prevId: string | null;
  nextId: string | null;
  targetCostPerWonCents: number | null;
  totals: {
    sent: number;
    won: number;
    wonPct: number | null;
    allWonPct: number | null;
    spendCents: number | null;
    costPerSentCents: number | null;
    costPerWonCents: number | null;
    status: CostStatus | null;
  };
  insight: string | null;
  stages: {
    key: string;
    name: string;
    count: number;
    allCount: number;
    movedOnPct: number | null;
    allMovedOnPct: number | null;
    lost: number;
    costEachCents: number | null;
  }[];
  batches: { batchId: string; name: string; sent: number; won: number }[];
  wonAccounts: { accountId: string; name: string; offerName: string | null; valueCents: number | null }[];
};

/**
 * `GET /analytics/sources/{id}/performance` (Ruling 11), for any source that is not removed. Rank, previous and
 * next are among the funnel rows for the same filters; a source that is not a row has none.
 */
export async function sourcePerformance(ctx: ModuleContext, sourceId: string, f: FunnelFilters, opts: FunnelOpts): Promise<SourcePerformance> {
  const b = await basis(ctx, f, opts);
  const s = b.sources.get(sourceId);
  if (!s || s.status === 'removed') throw new ScoutError({ slug: 'not-found', status: 404, title: 'That source was not found.' });
  const row = rowOf(b, sourceId);
  const rows = rowsOf(b);
  const at = rows.findIndex((r) => r.sourceId === sourceId);
  const ranked = rows.filter((r) => r.costPerWonCents !== null && r.counts[0]! >= 10).sort((x, y) => x.costPerWonCents! - y.costPerWonCents!);
  const rank = ranked.findIndex((r) => r.sourceId === sourceId);

  const flowIdx = b.flow.length - 1;
  const allCounts = stageCounts(b.cohort, b.flow);
  const allStep = stepPct(allCounts);
  const lost = lostAt(row.journeys, b.flow);
  const sent = row.journeys.length;
  const won = wonCount(row.counts);
  const wonJourneys = row.journeys.filter((j) => reachedIndex(j, b.flow) === flowIdx);

  const byBatch = new Map<string, { sent: number; won: number }>();
  for (const j of row.journeys) {
    if (!j.firstBatchId) continue;
    const t = byBatch.get(j.firstBatchId) ?? { sent: 0, won: 0 };
    t.sent += 1;
    if (reachedIndex(j, b.flow) === flowIdx) t.won += 1;
    byBatch.set(j.firstBatchId, t);
  }
  const bNames = await batchNames(ctx, [...byBatch.keys()]);
  const batches = [...byBatch]
    .map(([batchId, t]) => ({ batchId, name: bNames.get(batchId) ?? batchId, ...t }))
    .sort((x, y) => y.sent - x.sent || x.name.localeCompare(y.name));

  const aNames = await accountNames(ctx, wonJourneys.map((j) => j.accountId));
  const oNames = new Map((await listOffers(ctx)).map((o) => [o.id, o.name]));
  const wonAccounts = wonJourneys
    .map((j) => {
      const amounts = j.deals.filter((d) => d.status === 'won' && d.amountCents !== null).map((d) => d.amountCents!);
      return {
        accountId: j.accountId,
        name: aNames.get(j.accountId) ?? '',
        offerName: j.offerId ? (oNames.get(j.offerId) ?? null) : null,
        valueCents: amounts.length ? amounts.reduce((x, y) => x + y, 0) : null,
      };
    })
    .sort((x, y) => (y.valueCents ?? -1) - (x.valueCents ?? -1) || x.name.localeCompare(y.name));

  return {
    source: { id: sourceId, name: s.name, kind: s.kind },
    period: b.period,
    rank: rank < 0 ? null : rank + 1,
    of: ranked.length,
    prevId: at > 0 ? rows[at - 1]!.sourceId : null,
    nextId: at >= 0 && at < rows.length - 1 ? rows[at + 1]!.sourceId : null,
    targetCostPerWonCents: b.spend ? b.target : null,
    totals: {
      sent,
      won,
      wonPct: ratio(won * 100, sent),
      allWonPct: ratio(wonCount(allCounts) * 100, b.cohort.length),
      spendCents: row.spendCents,
      costPerSentCents: row.spendCents === null ? null : ratio(row.spendCents, sent),
      costPerWonCents: row.costPerWonCents,
      status: row.status,
    },
    insight: insight(row.counts, b.flow.map((st) => st.name), sent),
    stages: b.flow.map((st, k) => ({
      key: st.key,
      name: st.name,
      count: row.counts[k]!,
      allCount: allCounts[k]!,
      movedOnPct: row.stepPct[k]!,
      allMovedOnPct: allStep[k]!,
      lost: lost[k]!,
      costEachCents: row.costPerAccountCents ? row.costPerAccountCents[k]! : null,
    })),
    batches,
    wonAccounts,
  };
}

export type SourceStat = {
  sent: number;
  reviewed: number;
  assigned: number;
  won: number;
  reviewedPct: number | null;
  assignedPct: number | null;
  wonPct: number | null;
  byStage: { key: string; count: number }[];
  isNew: boolean;
  spendCents: number | null;
  costPerWonCents: number | null;
};

/** Fewer reviewed accounts than this and a source is "New" (as intake's Sources list). */
const NEW_UNDER_REVIEWED = 10;

/**
 * The Sources page numbers (Ruling 13), for all time, from journeys: each account under its first source with
 * children rolled up, at the furthest stage it reached, over the accounts the caller can see. Reviewed is the
 * second flow stage, Assigned the first assigned one, Won the last. `byStage` is where the accounts went: an
 * account with an exit under its exit, else under its furthest flow stage. Spend is all-time and never narrowed.
 */
export async function sourceStatsFromJourneys(ctx: ModuleContext, sourceIds: string[], opts: { spend: boolean }): Promise<Map<string, SourceStat>> {
  const stages = await stageDefs(ctx);
  const flow = stages.filter((s) => s.kind === 'flow');
  const exits = new Set(stages.filter((s) => s.kind === 'exit').map((s) => s.key));
  const all = await loadJourneys(ctx);
  const seen = await visible(ctx, all);
  const { tree } = await sourceTree(ctx);
  const { bySource } = opts.spend ? spendBySource(await spendLines(ctx), firstSources(all)) : { bySource: new Map<string, number>() };
  const assignedAt = flow.findIndex((s) => s.assigned);
  const out = new Map<string, SourceStat>();
  for (const id of sourceIds) {
    const below = rollUp(id, tree);
    const js = seen.filter((j) => below.has(j.firstSourceId));
    const counts = stageCounts(js, flow);
    const sent = js.length;
    const reviewed = counts[1] ?? 0;
    const assigned = assignedAt < 0 ? 0 : counts[assignedAt]!;
    const won = wonCount(counts);
    const exited = (j: Journey) => !!j.exitStage && exits.has(j.exitStage);
    const byStage = stages.map((s) => {
      const k = flow.indexOf(s);
      return {
        key: s.key,
        count: s.kind === 'exit' ? js.filter((j) => j.exitStage === s.key).length : js.filter((j) => !exited(j) && reachedIndex(j, flow) === k).length,
      };
    });
    const spend = opts.spend ? spendOf(below, bySource) : null;
    out.set(id, {
      sent,
      reviewed,
      assigned,
      won,
      reviewedPct: ratio(reviewed * 100, sent),
      assignedPct: ratio(assigned * 100, reviewed),
      wonPct: ratio(won * 100, assigned),
      byStage,
      isNew: reviewed < NEW_UNDER_REVIEWED,
      spendCents: spend,
      costPerWonCents: spend === null ? null : ratio(spend, won),
    });
  }
  return out;
}
