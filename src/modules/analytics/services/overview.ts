import { filterVisibleAccountIds } from '@/modules/accounts';
import { sourceTree } from '@/modules/intake';
import { listOffers } from '@/modules/offers';
import { listStages } from '@/modules/routing';
import { tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { dayOf } from '../domain/budgets';
import { ratio, reachedIndex, type StageDef } from '../domain/funnel';
import { enteredIn, medianDays, openValueCents, opportunityIndex, pace, quarterOf, stageEntry, wonIndex, wonValueCents, type Pace, type Quarter } from '../domain/overview';
import { stageDefs } from './costs-by-source';
import { journeysUpdatedAt, loadJourneys, type Journey } from './journeys';

/** A live stage as the overview reads it: the funnel's definition plus what the stages editor stores. */
export type OverviewStage = StageDef & { trigger: string; locked: string | null; quarterTarget: number | null; description: string | null; triggerLabel: string };

/** What every Overview read (tiles, funnel, scorecard, drawer) starts from, under the caller's data limit. */
export type OverviewBasis = {
  q: Quarter;
  timezone: string;
  flow: OverviewStage[];
  exits: OverviewStage[];
  oppIdx: number;
  wonIdx: number;
  journeys: Journey[];
  priceOf: (offerId: string | null) => number | null;
  offers: Awaited<ReturnType<typeof listOffers>>;
  tree: Map<string, string[]>;
  sources: Awaited<ReturnType<typeof sourceTree>>['sources'];
};

/** The quarter of `now`, the live stages, and the journeys the caller can see (Rulings 1-3 and 11). */
export async function overviewBasis(ctx: ModuleContext, now: Date): Promise<OverviewBasis> {
  const timezone = await tenantTimezone(ctx);
  const defs = new Map((await stageDefs(ctx)).map((s) => [s.key, s]));
  const stages: OverviewStage[] = (await listStages(ctx)).stages.map((s) => ({
    ...defs.get(s.key)!,
    trigger: s.trigger,
    locked: s.locked,
    quarterTarget: s.quarterTarget,
    description: s.description,
    triggerLabel: s.triggerLabel,
  }));
  const flow = stages.filter((s) => s.kind === 'flow');
  const all = await loadJourneys(ctx);
  const ok = new Set(await filterVisibleAccountIds(ctx, all.map((j) => j.accountId)));
  const offers = await listOffers(ctx);
  const prices = new Map(offers.map((o) => [o.id, o.priceMinCents]));
  const { tree, sources } = await sourceTree(ctx);
  return {
    q: quarterOf(now, timezone),
    timezone,
    flow,
    exits: stages.filter((s) => s.kind === 'exit'),
    oppIdx: opportunityIndex(flow),
    wonIdx: wonIndex(flow),
    journeys: all.filter((j) => ok.has(j.accountId)),
    priceOf: (offerId) => (offerId ? (prices.get(offerId) ?? null) : null),
    offers,
    tree,
    sources,
  };
}

type Named = { key: string; name: string };
const named = (s: Named): Named => ({ key: s.key, name: s.name });

export type OverviewView = {
  quarter: { label: string; from: string; to: string; week: number; weeks: number; pace_pct: number };
  opportunity_stage: Named;
  won_stage: Named;
  first_stage: Named;
  kpis: {
    pipeline_value_cents: number;
    pipeline_accounts: number;
    won_value_cents: number;
    won_accounts: number;
    sent_to_won_pct: number | null;
    days_to_win: number | null;
  };
  stages: {
    key: string;
    name: string;
    count: number;
    pct_of_previous: number | null;
    value_cents: number | null;
    target: number | null;
    expected: number | null;
    pace: Pace | null;
  }[];
  exits: { key: string; name: string; count: number }[];
  updated_at: string | null;
};

/** `GET /analytics/overview` (R3c-1 Rulings 1-6 and 11): the tiles, the funnel bands with their pace, and the exits. */
export async function overview(ctx: ModuleContext, opts: { now?: Date } = {}): Promise<OverviewView> {
  const now = opts.now ?? new Date();
  const b = await overviewBasis(ctx, now);
  const w = { from: b.q.from, to: b.q.to };

  const counts = b.flow.map((_, k) => b.journeys.filter((j) => enteredIn(j, b.flow, k, w)).length);
  const pipeline = b.journeys.filter((j) => {
    const r = reachedIndex(j, b.flow);
    return !j.exitStage && r >= b.oppIdx && r < b.wonIdx;
  });
  const pipelineValue = pipeline.reduce((s, j) => s + openValueCents(j, b.priceOf(j.offerId)), 0);
  const wonValue = b.journeys.reduce((s, j) => s + wonValueCents(j, b.priceOf(j.offerId), w), 0);

  const arrived = b.journeys.filter((j) => j.arrivedAt >= w.from && j.arrivedAt <= w.to);
  const wonOf = arrived.filter((j) => stageEntry(j, b.flow, b.wonIdx) !== null).length;
  const wins = b.journeys.filter((j) => enteredIn(j, b.flow, b.wonIdx, w));
  const sentToWon = ratio(wonOf * 1000, arrived.length);

  return {
    quarter: {
      label: b.q.label,
      from: dayOf(b.q.from, b.timezone),
      to: dayOf(b.q.to, b.timezone),
      week: b.q.week,
      weeks: b.q.weeks,
      pace_pct: Math.round(b.q.share * 100),
    },
    opportunity_stage: named(b.flow[b.oppIdx]!),
    won_stage: named(b.flow[b.wonIdx]!),
    first_stage: named(b.flow[0]!),
    kpis: {
      pipeline_value_cents: pipelineValue,
      pipeline_accounts: pipeline.length,
      won_value_cents: wonValue,
      won_accounts: wins.length,
      sent_to_won_pct: sentToWon === null ? null : sentToWon / 10,
      days_to_win: medianDays(wins.map((j) => [j.arrivedAt, stageEntry(j, b.flow, b.wonIdx)!])),
    },
    stages: b.flow.map((s, k) => {
      const p = pace(counts[k]!, s.quarterTarget, b.q.share);
      return {
        key: s.key,
        name: s.name,
        count: counts[k]!,
        pct_of_previous: k === 0 ? null : ratio(counts[k]! * 100, counts[k - 1]!),
        value_cents: k === b.wonIdx ? wonValue : k === b.oppIdx ? pipelineValue : null,
        target: s.quarterTarget,
        expected: p?.expected ?? null,
        pace: p?.pace ?? null,
      };
    }),
    exits: b.exits.map((s) => ({
      key: s.key,
      name: s.name,
      count: b.journeys.filter((j) => j.exitStage === s.key && !!j.exitAt && j.exitAt >= w.from && j.exitAt <= w.to).length,
    })),
    updated_at: (await journeysUpdatedAt(ctx))?.toISOString() ?? null,
  };
}
