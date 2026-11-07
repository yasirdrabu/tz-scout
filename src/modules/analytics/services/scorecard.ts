import { listMeetingFacts } from '@/modules/crm';
import { listPractices, priceLabel } from '@/modules/offers';
import { listStepFacts } from '@/modules/playbooks';
import { listAssignmentFacts } from '@/modules/routing';
import { tenantSummary, userNames } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { dayOf } from '../domain/budgets';
import { ratio, reachedIndex } from '../domain/funnel';
import { enteredIn, openValueCents, teamTone, wonValueCents, type Tone } from '../domain/overview';
import type { Journey } from './journeys';
import { overviewBasis, type OverviewBasis } from './overview';

export const TABS = ['sellers', 'offers', 'practices'] as const;
export type ScorecardTab = (typeof TABS)[number];
export const CHOOSE_TAB = 'Choose a tab: sellers, offers or practices.';

/** The `tab` query value; absent or unknown is a 400. */
export function parseTab(value: string | null): ScorecardTab {
  if (!TABS.includes(value as ScorecardTab)) {
    throw new ScoutError({ slug: 'validation', status: 400, title: CHOOSE_TAB, errors: [{ path: 'tab', message: CHOOSE_TAB }] });
  }
  return value as ScorecardTab;
}

type AssignmentFact = Awaited<ReturnType<typeof listAssignmentFacts>>[number];

/** The seller of each account (Ruling 7): the one on the latest assignment, by `assignedAt`, that has `acceptedHow` set. */
export function sellerOf(facts: AssignmentFact[]): Map<string, string> {
  const latest = new Map<string, AssignmentFact>();
  for (const f of facts) {
    if (!f.acceptedHow) continue;
    const cur = latest.get(f.accountId);
    if (!cur || f.assignedAt >= cur.assignedAt) latest.set(f.accountId, f);
  }
  return new Map([...latest].map(([accountId, f]) => [accountId, f.sellerUserId]));
}

export type Cell = { value: number | null; sub?: string; tone: Tone | null };
const cell = (value: number | null, tone: Tone | null = null, sub?: string): Cell => ({ value, tone, ...(sub ? { sub } : {}) });

export type SellerRow = {
  seller_user_id: string;
  name: string;
  assigned: number;
  accepted: Cell;
  time_to_accept: Cell;
  steps_on_time: Cell;
  meetings: Cell;
  opportunities: Cell;
  won: Cell;
  pipeline_cents: Cell;
  win_rate: Cell;
};
export type OfferRow = {
  offer_id: string;
  name: string;
  practice_name: string | null;
  price_label: string | null;
  matched: Cell;
  opportunities: Cell;
  won: Cell;
  win_rate: Cell;
  won_value_cents: Cell;
  pipeline_cents: Cell;
};
export type PracticeRow = {
  practice_id: string;
  name: string;
  lead_name: string | null;
  offers: number;
  active_offers: number;
  matched: Cell;
  opportunities: Cell;
  won: Cell;
  win_rate: Cell;
  won_value_cents: Cell;
  pipeline_cents: Cell;
};
export type ScorecardView = {
  tab: ScorecardTab;
  quarter_label: string;
  rows: SellerRow[] | OfferRow[] | PracticeRow[];
  team: Record<string, number | null> | null;
};

const HOUR = 3_600_000;
const pct = (n: number, d: number) => (d === 0 ? null : (n * 100) / d);
const round = (v: number | null) => (v === null ? null : Math.round(v));
const byWonThenName = <T extends { name: string; won: Cell }>(a: T, b: T) => b.won.value! - a.won.value! || a.name.localeCompare(b.name);

/** Win rate colour (Ruling 10): good from 15%, attention under 10%, null with nothing matched. */
const winBand = (v: number | null): Tone | null => (v === null ? null : v >= 15 ? 'good' : v < 10 ? 'attention' : 'neutral');

export const inPipeline = (b: OverviewBasis, j: Journey) => {
  const r = reachedIndex(j, b.flow);
  return !j.exitStage && r >= b.oppIdx && r < b.wonIdx;
};

/** The shared numbers of a set of accounts, for the offer and practice rows: `matched` arrived this quarter, the rest per Ruling 10. */
function productRow(b: OverviewBasis, js: Journey[]) {
  const w = { from: b.q.from, to: b.q.to };
  const matched = js.filter((j) => j.arrivedAt >= w.from && j.arrivedAt <= w.to).length;
  const opps = js.filter((j) => enteredIn(j, b.flow, b.oppIdx, w)).length;
  const wins = js.filter((j) => enteredIn(j, b.flow, b.wonIdx, w));
  const wonValue = wins.reduce((s, j) => s + wonValueCents(j, b.priceOf(j.offerId), w), 0);
  const pipeline = js.filter((j) => inPipeline(b, j)).reduce((s, j) => s + openValueCents(j, b.priceOf(j.offerId)), 0);
  const rate = ratio(wins.length * 100, matched);
  return {
    any: matched > 0 || opps > 0 || wins.length > 0 || wonValue > 0 || pipeline > 0,
    cells: {
      matched: cell(matched),
      opportunities: cell(opps),
      won: cell(wins.length),
      win_rate: cell(rate, winBand(rate), 'Of matched'),
      won_value_cents: cell(wonValue),
      pipeline_cents: cell(pipeline),
    },
  };
}

async function offersTab(ctx: ModuleContext, b: OverviewBasis): Promise<OfferRow[]> {
  const { currency } = await tenantSummary(ctx);
  const practices = new Map((await listPractices(ctx, { includeArchived: true })).map((p) => [p.id, p.name]));
  const rows: OfferRow[] = [];
  for (const o of b.offers) {
    const { any, cells } = productRow(b, b.journeys.filter((j) => j.offerId === o.id));
    if (o.status === 'archived' && !any) continue;
    rows.push({ offer_id: o.id, name: o.name, practice_name: practices.get(o.practiceId) ?? null, price_label: priceLabel(o, currency), ...cells });
  }
  return rows.sort(byWonThenName);
}

async function practicesTab(ctx: ModuleContext, b: OverviewBasis): Promise<PracticeRow[]> {
  const practices = await listPractices(ctx);
  const leads = await userNames(ctx, practices.flatMap((p) => (p.leadUserId ? [p.leadUserId] : [])));
  return practices
    .map((p): PracticeRow => {
      const mine = b.offers.filter((o) => o.practiceId === p.id && o.status !== 'archived');
      return {
        practice_id: p.id,
        name: p.name,
        lead_name: p.leadUserId ? (leads.get(p.leadUserId) ?? null) : null,
        offers: mine.length,
        active_offers: mine.filter((o) => o.status === 'approved').length,
        ...productRow(b, b.journeys.filter((j) => j.practiceId === p.id)).cells,
      };
    })
    .sort(byWonThenName);
}

/** What each seller did this quarter on the accounts the caller can see (Ruling 8), by account; the scorecard and the metric drawer both read it. */
export type SellerFacts = {
  /** Distinct accounts assigned this quarter, with the first assignment's time. */
  assigned: Map<string, Date>;
  /** Accepted ones, with the assignment time and the clock hours to accept (NaN when there is no response time). */
  accepted: Map<string, { assignedAt: Date; respondedAt: Date | null; hours: number }>;
  /** Meetings this quarter on the seller's accounts (Ruling 7), with the latest one. */
  meetings: Map<string, { n: number; last: Date }>;
  /** Seller-owned plan steps due this quarter up to today, not skipped. */
  steps: { accountId: string; dueDate: string; onTime: boolean }[];
};

export async function sellerFacts(ctx: ModuleContext, b: OverviewBasis, now: Date): Promise<{ bySeller: Map<string, SellerFacts>; sellerByAccount: Map<string, string> }> {
  const w = { from: b.q.from, to: b.q.to };
  const visible = new Set(b.journeys.map((j) => j.accountId));
  const facts = await listAssignmentFacts(ctx);
  const sellerByAccount = sellerOf(facts);
  const bySeller = new Map<string, SellerFacts>();

  for (const f of facts) {
    if (f.assignedAt < w.from || f.assignedAt > w.to || !visible.has(f.accountId)) continue;
    const a = bySeller.get(f.sellerUserId) ?? bySeller.set(f.sellerUserId, { assigned: new Map(), accepted: new Map(), meetings: new Map(), steps: [] }).get(f.sellerUserId)!;
    if (!a.assigned.has(f.accountId)) a.assigned.set(f.accountId, f.assignedAt);
    if (f.acceptedHow && !a.accepted.has(f.accountId)) {
      a.accepted.set(f.accountId, { assignedAt: f.assignedAt, respondedAt: f.respondedAt, hours: f.respondedAt ? (f.respondedAt.getTime() - f.assignedAt.getTime()) / HOUR : NaN });
    }
  }
  for (const m of await listMeetingFacts(ctx, w)) {
    const s = sellerByAccount.get(m.accountId);
    const a = s ? bySeller.get(s) : undefined;
    if (!a || !visible.has(m.accountId)) continue;
    const cur = a.meetings.get(m.accountId);
    a.meetings.set(m.accountId, { n: (cur?.n ?? 0) + 1, last: cur && cur.last > m.occurredAt ? cur.last : m.occurredAt });
  }
  const steps = await listStepFacts(ctx, { fromDay: dayOf(b.q.from, b.timezone), toDay: dayOf(now, b.timezone) });
  for (const s of steps) {
    if (s.status === 'skipped' || !visible.has(s.accountId) || !bySeller.has(s.ownerUserId)) continue;
    bySeller.get(s.ownerUserId)!.steps.push({ accountId: s.accountId, dueDate: s.dueDate, onTime: !!s.doneAt && dayOf(s.doneAt, b.timezone) <= s.dueDate });
  }
  return { bySeller, sellerByAccount };
}

async function sellersTab(ctx: ModuleContext, b: OverviewBasis, now: Date): Promise<{ rows: SellerRow[]; team: Record<string, number | null> }> {
  const w = { from: b.q.from, to: b.q.to };
  const { bySeller, sellerByAccount } = await sellerFacts(ctx, b, now);

  const raw = [...bySeller].map(([sellerId, a]) => {
    const mine = b.journeys.filter((j) => sellerByAccount.get(j.accountId) === sellerId);
    const hours = [...a.accepted.values()].map((x) => x.hours).filter((h) => !Number.isNaN(h));
    const opps = mine.filter((j) => enteredIn(j, b.flow, b.oppIdx, w)).length;
    const won = mine.filter((j) => enteredIn(j, b.flow, b.wonIdx, w)).length;
    return {
      sellerId, assigned: a.assigned.size, accepted: a.accepted.size, hours: hours.reduce((s, h) => s + h, 0), responded: hours.length,
      stepsDone: a.steps.filter((x) => x.onTime).length, steps: a.steps.length, meetings: [...a.meetings.values()].reduce((n, m) => n + m.n, 0), opps, won,
      pipeline: mine.filter((j) => inPipeline(b, j)).reduce((s, j) => s + openValueCents(j, b.priceOf(j.offerId)), 0),
    };
  });
  const sum = (f: (r: (typeof raw)[number]) => number) => raw.reduce((s, r) => s + f(r), 0);
  const team = {
    accepted: pct(sum((r) => r.accepted), sum((r) => r.assigned)),
    time_to_accept: sum((r) => r.responded) ? sum((r) => r.hours) / sum((r) => r.responded) : null,
    steps_on_time: pct(sum((r) => r.stepsDone), sum((r) => r.steps)),
    win_rate: pct(sum((r) => r.won), sum((r) => r.opps)),
  };
  const values = raw.map((r) => ({
    accepted: pct(r.accepted, r.assigned),
    time_to_accept: r.responded ? r.hours / r.responded : null,
    steps_on_time: pct(r.stepsDone, r.steps),
    win_rate: pct(r.won, r.opps),
  }));
  const withValue = (k: keyof typeof team) => values.filter((v) => v[k] !== null).length;
  const tone = (k: keyof typeof team, v: number | null) => teamTone(v, team[k], k === 'time_to_accept', withValue(k));

  const names = await userNames(ctx, raw.map((r) => r.sellerId));
  const rows = raw.map((r, i): SellerRow => {
    const v = values[i]!;
    return {
      seller_user_id: r.sellerId,
      name: names.get(r.sellerId) ?? 'Former member',
      assigned: r.assigned,
      accepted: cell(round(v.accepted), tone('accepted', v.accepted), `${r.accepted} of ${r.assigned}`),
      time_to_accept: cell(round(v.time_to_accept), tone('time_to_accept', v.time_to_accept), 'Average'),
      steps_on_time: cell(round(v.steps_on_time), tone('steps_on_time', v.steps_on_time), 'Playbook steps'),
      meetings: cell(r.meetings),
      opportunities: cell(r.opps),
      won: cell(r.won),
      pipeline_cents: cell(r.pipeline),
      win_rate: cell(round(v.win_rate), tone('win_rate', v.win_rate), 'Of opportunities'),
    };
  });
  return {
    rows: rows.sort(byWonThenName),
    team: { accepted: round(team.accepted), time_to_accept: round(team.time_to_accept), steps_on_time: round(team.steps_on_time), win_rate: round(team.win_rate) },
  };
}

/** `GET /analytics/scorecard` (R3c-1 Rulings 7-11): the Overview's scorecard by seller, offer or practice, under the caller's data limit. */
export async function scorecard(ctx: ModuleContext, tab: ScorecardTab, opts: { now?: Date } = {}): Promise<ScorecardView> {
  const now = opts.now ?? new Date();
  const b = await overviewBasis(ctx, now);
  if (tab === 'sellers') {
    const { rows, team } = await sellersTab(ctx, b, now);
    return { tab, quarter_label: b.q.label, rows, team };
  }
  return { tab, quarter_label: b.q.label, rows: tab === 'offers' ? await offersTab(ctx, b) : await practicesTab(ctx, b), team: null };
}
