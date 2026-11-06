import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { sourceTree, type SourceKind } from '@/modules/intake';
import { listStages, routingFunnelStages } from '@/modules/routing';
import { tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { costLine, costSetting } from '../db/schema';
import { ratio, reachedIndex, rollUp, spendBySource, type StageDef } from '../domain/funnel';
import { periodRange } from '../domain/period';
import { loadJourneys, type Journey } from './journeys';

export const TARGET_ABOVE_ZERO = 'Enter a target above zero, or clear it.';
const SHARED = 'Shared costs';

export type CostBySourceRow =
  | {
      sourceId: string;
      name: string;
      kind: SourceKind;
      spendCents: number;
      sharePct: number | null;
      perSentCents: number | null;
      perAssignedCents: number | null;
      perWonCents: number | null;
      returnRatio: number | null;
    }
  | { sourceId: null; name: typeof SHARED; spendCents: number; sharePct: number | null };

/** The workspace's live stages, flow then exits in order, each marked `assigned` as routing counts it (Ruling 3). */
export async function stageDefs(ctx: ModuleContext): Promise<StageDef[]> {
  const { stages } = await listStages(ctx);
  const assigned = new Set((await routingFunnelStages.stages(ctx)).filter((s) => s.assigned).map((s) => s.key));
  return stages.map((s) => ({ key: s.key, name: s.name, kind: s.kind, assigned: assigned.has(s.key) }));
}

export type SpendLine = { amountCents: number; sourceId: string | null; accountId: string | null };

type Window = { from: Date; to: Date; flow: StageDef[]; journeys: Journey[]; lines: SpendLine[] };

/** The non-voided cost lines (Ruling 6), dated between the two days when given, else all of them. */
export async function spendLines(ctx: ModuleContext, days?: { fromDay: string; toDay: string }): Promise<SpendLine[]> {
  return ctx.tx
    .select({ amountCents: costLine.amountCents, sourceId: costLine.sourceId, accountId: costLine.accountId })
    .from(costLine)
    .where(
      and(
        eq(costLine.tenantId, ctx.tenantId),
        isNull(costLine.voidedAt),
        days ? gte(costLine.occurredOn, days.fromDay) : undefined,
        days ? lte(costLine.occurredOn, days.toDay) : undefined,
      ),
    );
}

/** The spend of a source and those below it (`below`, from `rollUp`), from the per-source spend. */
export const spendOf = (below: Set<string>, bySource: Map<string, number>): number => [...below].reduce((sum, b) => sum + (bySource.get(b) ?? 0), 0);

/** The last 90 days (Ruling 5): every journey, the flow stages, and the non-voided lines dated in the window. */
async function lastNinetyDays(ctx: ModuleContext, now: Date): Promise<Window> {
  const { from, to, fromDay, toDay } = periodRange('90d', now, await tenantTimezone(ctx));
  const flow = (await stageDefs(ctx)).filter((s) => s.kind === 'flow');
  const journeys = await loadJourneys(ctx);
  const lines = await spendLines(ctx, { fromDay, toDay });
  return { from, to, flow, journeys, lines };
}

/**
 * Over the window: sent (arrived in it), assigned (of those, reached an assigned stage), won (entered the last flow
 * stage in it) and won value (amounts of won deals closed in it; a deal with no amount adds nothing).
 */
function tally(js: Journey[], w: Window) {
  const inWindow = (d: Date | null | undefined) => !!d && d >= w.from && d <= w.to;
  const wonKey = w.flow[w.flow.length - 1]!.key;
  const sent = js.filter((j) => inWindow(j.arrivedAt));
  const assigned = sent.filter((j) => {
    const r = reachedIndex(j, w.flow);
    return w.flow.some((s, i) => s.assigned && i <= r);
  });
  const wonValueCents = js.reduce((sum, j) => sum + j.deals.reduce((s, d) => s + (d.status === 'won' && inWindow(d.closedAt) ? (d.amountCents ?? 0) : 0), 0), 0);
  return { sent: sent.length, assigned: assigned.length, won: js.filter((j) => inWindow(j.stages.get(wonKey))).length, wonValueCents };
}

/** Won value over spend, to 1 decimal; null when nothing was spent. */
const returnRatio = (valueCents: number, spendCents: number) => (spendCents === 0 ? null : Math.round((valueCents * 10) / spendCents) / 10);

export const sumOf = (lines: { amountCents: number }[]) => lines.reduce((s, l) => s + l.amountCents, 0);

/** The Costs tiles over the last 90 days (Ruling 12): the ledger total per account sent and per won, and the return. */
export async function spendReturns(ctx: ModuleContext, now: Date): Promise<{ costPerSentCents: number | null; costPerWonCents: number | null; returnRatio: number | null }> {
  const w = await lastNinetyDays(ctx, now);
  const spend = sumOf(w.lines);
  const t = tally(w.journeys, w);
  return { costPerSentCents: ratio(spend, t.sent), costPerWonCents: ratio(spend, t.won), returnRatio: returnRatio(t.wonValueCents, spend) };
}

/**
 * "Cost by source" (Ruling 12): each top-level source that is not removed, with spend or accounts sent in the last
 * 90 days, its children rolled up (Ruling 4), by spend then name; then Shared costs: lines with no source or account,
 * plus any spend that shows in no row (under a removed top-level source). The spends add up to the total.
 */
export async function costsBySource(ctx: ModuleContext, now: Date = new Date()): Promise<{ rows: CostBySourceRow[]; totalSpendCents: number }> {
  const w = await lastNinetyDays(ctx, now);
  const { tree, sources } = await sourceTree(ctx);
  const { bySource } = spendBySource(w.lines, new Map(w.journeys.map((j) => [j.accountId, j.firstSourceId])));
  const total = sumOf(w.lines);
  const rows: CostBySourceRow[] = [];
  for (const [id, s] of sources) {
    if (s.parentId || s.status === 'removed') continue;
    const below = rollUp(id, tree);
    const spend = spendOf(below, bySource);
    const t = tally(w.journeys.filter((j) => below.has(j.firstSourceId)), w);
    if (spend === 0 && t.sent === 0) continue;
    rows.push({
      sourceId: id,
      name: s.name,
      kind: s.kind,
      spendCents: spend,
      sharePct: ratio(spend * 100, total),
      perSentCents: ratio(spend, t.sent),
      perAssignedCents: ratio(spend, t.assigned),
      perWonCents: ratio(spend, t.won),
      returnRatio: returnRatio(t.wonValueCents, spend),
    });
  }
  rows.sort((a, b) => b.spendCents - a.spendCents || a.name.localeCompare(b.name));
  const shared = total - rows.reduce((s, r) => s + r.spendCents, 0);
  rows.push({ sourceId: null, name: SHARED, spendCents: shared, sharePct: ratio(shared * 100, total) });
  return { rows, totalSpendCents: total };
}

/** The workspace's target cost per won account, or null (Ruling 8: no default). */
export async function getTarget(ctx: ModuleContext): Promise<number | null> {
  const [row] = await ctx.tx.select({ cents: costSetting.targetCostPerWonCents }).from(costSetting).where(eq(costSetting.tenantId, ctx.tenantId));
  return row?.cents ?? null;
}

/** Sets the target (whole cents, 1 or more) or clears it with null. */
export async function setTarget(ctx: ModuleContext, cents: number | null): Promise<number | null> {
  if (cents !== null && (!Number.isSafeInteger(cents) || cents < 1)) {
    throw new ScoutError({ slug: 'validation', status: 400, title: TARGET_ABOVE_ZERO, errors: [{ path: 'target_cost_per_won_cents', message: TARGET_ABOVE_ZERO }] });
  }
  await ctx.tx
    .insert(costSetting)
    .values({ tenantId: ctx.tenantId, targetCostPerWonCents: cents, updatedBy: ctx.actor.id })
    .onConflictDoUpdate({ target: costSetting.tenantId, set: { targetCostPerWonCents: cents, updatedBy: ctx.actor.id, updatedAt: sql`now()` } });
  return cents;
}
