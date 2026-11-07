// Overview quarter, pace, value and colour rules (R3c-1 Rulings 1-6 and 9). Pure: no database, no clock.
import type { Journey } from '../services/journeys';
import { dayOf } from './budgets';
import type { StageDef } from './funnel';
import { localMidnight } from './period';

const DAY = 86_400_000;
type Window = { from: Date; to: Date };

export type Quarter = {
  from: Date; to: Date; end: Date; label: string; week: number; weeks: number; share: number; prev: { from: Date; to: Date };
};

/** The calendar quarter of `now` in the tenant timezone, and the same point in the quarter before. */
export function quarterOf(now: Date, timezone: string): Quarter {
  const day = dayOf(now, timezone);
  const year = Number(day.slice(0, 4));
  const q = Math.floor((Number(day.slice(5, 7)) - 1) / 3);
  const first = (y: number, i: number) => `${y}-${String(i * 3 + 1).padStart(2, '0')}-01`;
  const from = localMidnight(first(year, q), timezone);
  const end = localMidnight(q === 3 ? first(year + 1, 0) : first(year, q + 1), timezone);
  const prevFrom = localMidnight(q === 0 ? first(year - 1, 3) : first(year, q - 1), timezone);
  const elapsed = now.getTime() - from.getTime();
  return {
    from, to: now, end, label: `Q${q + 1} ${year}`,
    week: Math.floor(elapsed / DAY) + 1,
    weeks: Math.ceil(Math.round((end.getTime() - from.getTime()) / DAY) / 7),
    share: elapsed / (end.getTime() - from.getTime()),
    prev: { from: prevFrom, to: new Date(prevFrom.getTime() + elapsed) },
  };
}

/** When the account entered flow stage `k`: the earliest entry into it or any later flow stage. The first stage also counts `arrivedAt`. */
export function stageEntry(j: Journey, flow: StageDef[], k: number): Date | null {
  let best: Date | null = k === 0 ? j.arrivedAt : null;
  for (let i = k; i < flow.length; i++) {
    const at = j.stages.get(flow[i]!.key);
    if (at && (!best || at < best)) best = at;
  }
  return best;
}

export function enteredIn(j: Journey, flow: StageDef[], k: number, w: Window): boolean {
  const at = stageEntry(j, flow, k);
  return !!at && at >= w.from && at <= w.to;
}

export type Pace = 'behind' | 'on' | 'ahead';

/** Where the count stands against the target's share of the quarter; null with no target. */
export function pace(count: number, target: number | null, share: number): { expected: number; pace: Pace } | null {
  if (!target || target <= 0) return null;
  const want = target * share;
  const eps = 1e-9;
  return { expected: Math.round(want), pace: count < want * 0.9 - eps ? 'behind' : count >= want * 1.05 - eps ? 'ahead' : 'on' };
}

/** The median of whole days between each pair; the mean of the two middle values when even. Null when empty. */
export function medianDays(pairs: [Date, Date][]): number | null {
  if (!pairs.length) return null;
  const d = pairs.map(([a, b]) => Math.floor((b.getTime() - a.getTime()) / DAY)).sort((x, y) => x - y);
  const m = d.length >> 1;
  return d.length % 2 ? d[m]! : Math.round((d[m - 1]! + d[m]!) / 2);
}

/** Open deals' amounts (each falling back to the price); an account with no deal at all takes the price. */
export function openValueCents(j: Journey, priceCents: number | null): number {
  const price = priceCents ?? 0;
  if (!j.deals.length) return price;
  return j.deals.filter((d) => d.status === 'open').reduce((s, d) => s + (d.amountCents ?? price), 0);
}

/** Won deals closed inside the window, each falling back to the price. */
export function wonValueCents(j: Journey, priceCents: number | null, w: Window): number {
  const price = priceCents ?? 0;
  return j.deals
    .filter((d) => d.status === 'won' && d.closedAt && d.closedAt >= w.from && d.closedAt <= w.to)
    .reduce((s, d) => s + (d.amountCents ?? price), 0);
}

export type Tone = 'good' | 'neutral' | 'attention';

/** Colour of a row against the team: good at or better, attention when worse by over 10%, else neutral. Null with under 2 rows. */
export function teamTone(value: number | null, team: number | null, lowerIsBetter: boolean, rowsWithValue: number): Tone | null {
  if (value === null || team === null || rowsWithValue < 2) return null;
  const eps = 1e-9;
  if (lowerIsBetter) return value <= team + eps ? 'good' : value > team * 1.1 + eps ? 'attention' : 'neutral';
  return value >= team - eps ? 'good' : value < team * 0.9 - eps ? 'attention' : 'neutral';
}

/** Whole-percent change from `prev` to `cur`; null without a base. */
export const changePct = (cur: number, prev: number): number | null => (prev === 0 ? null : Math.round(((cur - prev) * 100) / prev));

type FlowStage = StageDef & { trigger: string; locked: string | null };

/** The Won position: the stage locked 'won', else the last. */
export function wonIndex(flow: FlowStage[]): number {
  const i = flow.findIndex((s) => s.locked === 'won');
  return i < 0 ? flow.length - 1 : i;
}

/** The Opportunity position: the `deal_created` stage, else the one just before Won. */
export function opportunityIndex(flow: FlowStage[]): number {
  const i = flow.findIndex((s) => s.trigger === 'deal_created');
  return i >= 0 ? i : Math.max(0, wonIndex(flow) - 1);
}
