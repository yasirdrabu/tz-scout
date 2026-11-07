import { accountNames } from '@/modules/accounts';
import { listPractices } from '@/modules/offers';
import { userNames } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { ratio } from '../domain/funnel';
import { localMidnight } from '../domain/period';
import { changePct, enteredIn, medianDays, openValueCents, pace, stageEntry, wonValueCents } from '../domain/overview';
import type { Journey } from './journeys';
import { overviewBasis, type OverviewBasis } from './overview';
import { inPipeline, sellerFacts, type SellerFacts } from './scorecard';

export type MetricScope = { stage?: string | undefined; seller?: string | undefined; offer?: string | undefined; practice?: string | undefined };

export type MetricDetail = {
  eyebrow: string;
  title: string;
  value: string;
  change_pct: number | null;
  definition: string;
  notes: { label: string; value: string }[];
  breakdowns: { label: string; items: { name: string; count: number; value: string }[] }[];
  accounts: { account_id: string; name: string; meta: string; at: string }[];
  total: number;
  see_all: { stage?: string; owner?: string; offer?: string; practice?: string } | null;
};

const CANT_EXPLAIN = "That number can't be explained.";
const unexplained = () => new ScoutError({ slug: 'validation', status: 400, title: CANT_EXPLAIN, errors: [{ path: 'key', message: CANT_EXPLAIN }] });
const missing = (what: string) => new ScoutError({ slug: 'not-found', status: 404, title: `That ${what} was not found.` });

const KPIS = ['pipeline_value', 'won_value', 'sent_to_won', 'days_to_win'];
const SELLER_METRICS = ['accepted', 'time_to_accept', 'steps_on_time', 'meetings', 'opportunities', 'won', 'pipeline', 'win_rate'];
const PRODUCT_METRICS = ['matched', 'opportunities', 'won', 'win_rate', 'won_value', 'pipeline'];

type Kind = 'count' | 'money' | 'pct' | 'pct1' | 'hours' | 'days';
type Hit = { accountId: string; at: Date; weight: number };
type Section = 'source' | 'offer' | 'seller';
type Note = { label: string; value: string };

type Resolved = {
  eyebrow: string;
  title: string;
  definition: string;
  kind: Kind;
  /** Whether the bars sum cents. */
  money: boolean;
  value: number | null;
  change: number | null;
  notes: Note[];
  hits: Hit[];
  sections: Section[];
  seeAll: MetricDetail['see_all'];
};

const count = (n: number) => n.toLocaleString('en-US');

/** "$1.2M" from a million dollars, "$84k" from a thousand, else "$950". */
export function moneyLabel(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000 || Math.round(dollars / 1000) >= 1000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1000) return `$${Math.round(dollars / 1000)}k`;
  return `$${Math.round(dollars)}`;
}

function format(kind: Kind, v: number | null): string {
  if (v === null) return kind === 'days' ? 'None yet' : '—';
  switch (kind) {
    case 'money': return moneyLabel(v);
    case 'pct': return `${Math.round(v)}%`;
    case 'pct1': return `${v}%`;
    case 'hours': return `${Math.round(v)} h`;
    case 'days': return String(v);
    default: return count(v);
  }
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const when = (s: { description: string | null; triggerLabel: string }) => `${s.description ? `${s.description} ` : ''}Counts when: ${lower(s.triggerLabel)}.`;
const hit = (accountId: string, at: Date, weight = 1): Hit => ({ accountId, at, weight });

/** The top-level ancestor of a source, as the funnel rolls up. */
function topSource(b: OverviewBasis, id: string): string {
  let cur = id;
  for (let i = 0; i < 50; i++) {
    const parent = b.sources.get(cur)?.parentId;
    if (!parent || !b.sources.has(parent)) break;
    cur = parent;
  }
  return cur;
}

const pipelineHits = (b: OverviewBasis, js: Journey[]): Hit[] =>
  js.filter((j) => inPipeline(b, j)).map((j) => hit(j.accountId, stageEntry(j, b.flow, b.oppIdx) ?? j.arrivedAt, openValueCents(j, b.priceOf(j.offerId))));

/** Pipeline value at the previous quarter's matching point (Ruling 1): a deal counts when it was still open then, even if it has closed since. */
function pipelineBefore(b: OverviewBasis): number {
  const at = b.q.prev.to;
  return b.journeys
    .filter((j) => {
      const opp = stageEntry(j, b.flow, b.oppIdx);
      const won = stageEntry(j, b.flow, b.wonIdx);
      return !!opp && opp <= at && (!won || won > at) && (!j.exitStage || !!j.exitAt && j.exitAt > at);
    })
    .reduce((s, j) => {
      const price = b.priceOf(j.offerId) ?? 0;
      if (!j.deals.length) return s + price;
      return s + j.deals.filter((d) => d.status === 'open' || (!!d.closedAt && d.closedAt > at)).reduce((n, d) => n + (d.amountCents ?? price), 0);
    }, 0);
}

type Window = { from: Date; to: Date };
const wonValueHits = (b: OverviewBasis, js: Journey[], w: Window): Hit[] =>
  js.flatMap((j) => {
    const v = wonValueCents(j, b.priceOf(j.offerId), w);
    const entry = enteredIn(j, b.flow, b.wonIdx, w) ? stageEntry(j, b.flow, b.wonIdx) : null;
    return entry || v > 0 ? [hit(j.accountId, entry ?? j.deals.find((d) => d.status === 'won' && d.closedAt)?.closedAt ?? j.arrivedAt, v)] : [];
  });

function exitStageOf(b: OverviewBasis, key: string | undefined) {
  const s = b.exits.find((x) => x.key === key);
  if (!s) throw missing('stage');
  return s;
}

function stageMetric(b: OverviewBasis, key: 'stage' | 'exit', scopeStage: string | undefined): Resolved {
  const w = { from: b.q.from, to: b.q.to };
  if (key === 'exit') {
    const s = exitStageOf(b, scopeStage);
    const inWin = (win: Window) => b.journeys.filter((j) => j.exitStage === s.key && !!j.exitAt && j.exitAt >= win.from && j.exitAt <= win.to);
    const hits = inWin(w).map((j) => hit(j.accountId, j.exitAt!));
    return {
      eyebrow: 'Left the pipeline · this quarter', title: s.name, definition: when(s), kind: 'count', money: false, value: hits.length,
      change: changePct(hits.length, inWin(b.q.prev).length), notes: [], hits, sections: ['source', 'offer', 'seller'], seeAll: { stage: s.key },
    };
  }
  const k = b.flow.findIndex((x) => x.key === scopeStage);
  if (k < 0) throw missing('stage');
  const s = b.flow[k]!;
  const hitsIn = (win: Window) => b.journeys.filter((j) => enteredIn(j, b.flow, k, win));
  const hits = hitsIn(w).map((j) => hit(j.accountId, stageEntry(j, b.flow, k)!));
  const notes: Note[] = [];
  if (k > 0) {
    const prev = b.flow[k - 1]!;
    const prevCount = b.journeys.filter((j) => enteredIn(j, b.flow, k - 1, w)).length;
    const moved = ratio(hits.length * 100, prevCount);
    notes.push({ label: `From ${prev.name}`, value: moved === null ? '—' : `${moved}% moved on` });
    notes.push({ label: `Still at ${prev.name} or left`, value: count(Math.max(0, prevCount - hits.length)) });
  }
  const p = pace(hits.length, s.quarterTarget, b.q.share);
  if (p) notes.push({ label: 'Quarter target', value: `${s.quarterTarget} · pace ${p.expected}` });
  if (k === b.oppIdx) notes.push({ label: 'Value', value: moneyLabel(pipelineHits(b, b.journeys).reduce((n, h) => n + h.weight, 0)) });
  if (k === b.wonIdx) notes.push({ label: 'Value', value: moneyLabel(b.journeys.reduce((n, j) => n + wonValueCents(j, b.priceOf(j.offerId), w), 0)) });
  const assigned = b.flow.findIndex((x) => x.assigned);
  return {
    eyebrow: 'Pipeline stage · this quarter', title: s.name, definition: when(s), kind: 'count', money: false, value: hits.length,
    change: changePct(hits.length, hitsIn(b.q.prev).length), notes, hits,
    sections: assigned >= 0 && k >= assigned ? ['source', 'offer', 'seller'] : ['source', 'offer'], seeAll: { stage: s.key },
  };
}

function kpiMetric(b: OverviewBasis, key: string): Resolved {
  const w = { from: b.q.from, to: b.q.to };
  const base = { eyebrow: 'Pipeline · this quarter', money: false, notes: [] as Note[], change: null as number | null, sections: ['source', 'offer', 'seller'] as Section[], seeAll: null as MetricDetail['see_all'] };
  const opp = b.flow[b.oppIdx]!;
  const won = b.flow[b.wonIdx]!;
  if (key === 'pipeline_value') {
    const hits = pipelineHits(b, b.journeys);
    const value = hits.reduce((n, h) => n + h.weight, 0);
    return { ...base, title: 'Pipeline value', definition: `Open accounts at ${opp.name}, valued at their deal amount or offer price.`, kind: 'money', money: true, value, change: changePct(value, pipelineBefore(b)), hits, seeAll: { stage: opp.key } };
  }
  if (key === 'won_value') {
    const hits = wonValueHits(b, b.journeys, w);
    const value = hits.reduce((n, h) => n + h.weight, 0);
    const before = wonValueHits(b, b.journeys, b.q.prev).reduce((n, h) => n + h.weight, 0);
    return { ...base, title: 'Won value', definition: `Accounts ${lower(won.name)} this quarter, valued at the signed amount or offer price.`, kind: 'money', money: true, value, change: changePct(value, before), hits, seeAll: { stage: won.key } };
  }
  if (key === 'sent_to_won') {
    const arrived = b.journeys.filter((j) => j.arrivedAt >= w.from && j.arrivedAt <= w.to);
    const wonOf = arrived.filter((j) => stageEntry(j, b.flow, b.wonIdx) !== null);
    const r = ratio(wonOf.length * 1000, arrived.length);
    return {
      ...base, title: `${b.flow[0]!.name} to ${won.name}`, definition: 'Share of accounts that entered the pipeline this quarter and were won.', kind: 'pct1', value: r === null ? null : r / 10,
      notes: [{ label: 'Entered', value: count(arrived.length) }, { label: 'Counted', value: count(wonOf.length) }], hits: wonOf.map((j) => hit(j.accountId, stageEntry(j, b.flow, b.wonIdx)!)),
    };
  }
  const wins = b.journeys.filter((j) => enteredIn(j, b.flow, b.wonIdx, w));
  return {
    ...base, title: 'Days to win', definition: 'Median days from entering the pipeline to being won.', kind: 'days',
    value: medianDays(wins.map((j) => [j.arrivedAt, stageEntry(j, b.flow, b.wonIdx)!])), notes: [{ label: 'Counted', value: count(wins.length) }],
    hits: wins.map((j) => hit(j.accountId, stageEntry(j, b.flow, b.wonIdx)!)),
  };
}

/** The numbers an offer, a practice or a seller shares: opportunities, won, win rate (against `denominator`), won value and pipeline. */
function sharedCell(b: OverviewBasis, js: Journey[], metric: string, matched: Hit[], rateOf: { label: string; hits: Hit[] }): Pick<Resolved, 'kind' | 'money' | 'value' | 'hits' | 'notes'> {
  const w = { from: b.q.from, to: b.q.to };
  const entered = (k: number) => js.filter((j) => enteredIn(j, b.flow, k, w)).map((j) => hit(j.accountId, stageEntry(j, b.flow, k)!));
  const none = { money: false, notes: [] as Note[] };
  switch (metric) {
    case 'matched': return { ...none, kind: 'count', value: matched.length, hits: matched };
    case 'opportunities': return { ...none, kind: 'count', value: entered(b.oppIdx).length, hits: entered(b.oppIdx) };
    case 'won': return { ...none, kind: 'count', value: entered(b.wonIdx).length, hits: entered(b.wonIdx) };
    case 'win_rate': {
      const wins = entered(b.wonIdx);
      const r = ratio(wins.length * 100, rateOf.hits.length);
      return { kind: 'pct', money: false, value: r, hits: wins, notes: [{ label: rateOf.label, value: count(rateOf.hits.length) }, { label: 'Counted', value: count(wins.length) }] };
    }
    case 'won_value': {
      const wins = new Set(entered(b.wonIdx).map((h) => h.accountId));
      const hits = wonValueHits(b, js.filter((j) => wins.has(j.accountId)), w);
      return { ...none, kind: 'money', money: true, value: hits.reduce((n, h) => n + h.weight, 0), hits };
    }
    default: {
      const hits = pipelineHits(b, js);
      return { ...none, kind: 'money', money: true, value: hits.reduce((n, h) => n + h.weight, 0), hits };
    }
  }
}

function sellerMetric(b: OverviewBasis, metric: string, sellerId: string, facts: SellerFacts, sellerByAccount: Map<string, string>, name: string): Resolved {
  const mine = b.journeys.filter((j) => sellerByAccount.get(j.accountId) === sellerId);
  const w = { from: b.q.from, to: b.q.to };
  const opps = mine.filter((j) => enteredIn(j, b.flow, b.oppIdx, w)).map((j) => hit(j.accountId, stageEntry(j, b.flow, b.oppIdx)!));
  const labels: Record<string, string> = {
    accepted: 'Accepted', time_to_accept: 'Time to accept', steps_on_time: 'Steps on time', meetings: 'Meetings', opportunities: 'Opportunities', won: 'Won', pipeline: 'Pipeline', win_rate: 'Win rate',
  };
  const defs: Record<string, string> = {
    accepted: 'Share of assigned accounts this seller accepted.',
    time_to_accept: 'Average hours from assignment to acceptance.',
    steps_on_time: 'Playbook steps done by their due date.',
    meetings: 'Meetings with accounts this seller owns.',
    opportunities: `Accounts this seller moved to ${b.flow[b.oppIdx]!.name}.`,
    won: 'Accounts this seller won this quarter.',
    pipeline: 'Value of open opportunities, from the deal amount or offer price.',
    win_rate: 'Won accounts divided by opportunities.',
  };
  const head = { eyebrow: `${name} · seller`, title: labels[metric]!, definition: defs[metric]!, change: null, sections: ['offer', 'source'] as Section[], seeAll: { owner: sellerId } };
  const accepted = [...facts.accepted].map(([id, a]) => hit(id, a.assignedAt));
  switch (metric) {
    case 'accepted': {
      const r = facts.assigned.size ? (accepted.length * 100) / facts.assigned.size : null;
      return { ...head, kind: 'pct', money: false, value: r === null ? null : Math.round(r), hits: accepted, notes: [{ label: 'Assigned', value: count(facts.assigned.size) }, { label: 'Counted', value: count(accepted.length) }] };
    }
    case 'time_to_accept': {
      const timed = [...facts.accepted].filter(([, a]) => !Number.isNaN(a.hours));
      const mean = timed.length ? timed.reduce((n, [, a]) => n + a.hours, 0) / timed.length : null;
      return { ...head, kind: 'hours', money: false, value: mean === null ? null : Math.round(mean), hits: timed.map(([id, a]) => hit(id, a.respondedAt!)), notes: [{ label: 'Counted', value: count(timed.length) }] };
    }
    case 'steps_on_time': {
      const onTime = facts.steps.filter((s) => s.onTime);
      const r = facts.steps.length ? (onTime.length * 100) / facts.steps.length : null;
      const latest = new Map<string, Date>();
      for (const s of onTime) {
        const d = localMidnight(s.dueDate, b.timezone);
        if (!latest.has(s.accountId) || latest.get(s.accountId)! < d) latest.set(s.accountId, d);
      }
      return {
        ...head, kind: 'pct', money: false, value: r === null ? null : Math.round(r), hits: [...latest].map(([id, d]) => hit(id, d)),
        notes: [{ label: 'Steps due', value: count(facts.steps.length) }, { label: 'Counted', value: count(onTime.length) }],
      };
    }
    case 'meetings': {
      const hits = [...facts.meetings].map(([id, m]) => hit(id, m.last, m.n));
      return { ...head, kind: 'count', money: false, value: hits.reduce((n, h) => n + h.weight, 0), hits, notes: [] };
    }
    default:
      return { ...head, ...sharedCell(b, mine, metric, [], { label: 'Opportunities', hits: opps }) };
  }
}

function productMetric(b: OverviewBasis, kind: 'offer' | 'practice', metric: string, name: string, id: string): Resolved {
  const w = { from: b.q.from, to: b.q.to };
  const js = b.journeys.filter((j) => (kind === 'offer' ? j.offerId : j.practiceId) === id);
  const matched = js.filter((j) => j.arrivedAt >= w.from && j.arrivedAt <= w.to).map((j) => hit(j.accountId, j.arrivedAt));
  const labels: Record<string, string> = { matched: 'Matched', opportunities: 'Opportunities', won: 'Won', win_rate: 'Win rate', won_value: 'Won value', pipeline: 'Pipeline' };
  const defs: Record<string, string> = {
    matched: `Accounts Scout matched to this ${kind} this quarter.`,
    opportunities: `Matched accounts that reached ${b.flow[b.oppIdx]!.name}.`,
    won: 'Matched accounts won this quarter.',
    win_rate: 'Won divided by matched.',
    won_value: 'Won accounts at their deal amount or offer price.',
    pipeline: 'Open opportunities at their deal amount or offer price.',
  };
  return {
    eyebrow: `${name} · ${kind}`, title: labels[metric]!, definition: defs[metric]!, change: null,
    sections: kind === 'offer' ? ['source', 'seller'] : ['offer', 'seller'], seeAll: kind === 'offer' ? { offer: id } : { practice: id },
    ...sharedCell(b, js, metric, matched, { label: 'Matched', hits: matched }),
  };
}

async function resolve(ctx: ModuleContext, b: OverviewBasis, key: string, scope: MetricScope, sf: Awaited<ReturnType<typeof sellerFacts>>): Promise<Resolved> {
  if (key === 'stage' || key === 'exit') {
    if (!scope.stage) throw unexplained();
    return stageMetric(b, key, scope.stage);
  }
  if (KPIS.includes(key)) return kpiMetric(b, key);
  const dot = key.indexOf('.');
  const kind = key.slice(0, dot);
  const metric = key.slice(dot + 1);
  if (kind === 'seller' && SELLER_METRICS.includes(metric)) {
    if (!scope.seller) throw unexplained();
    const facts = sf.bySeller.get(scope.seller);
    if (!facts) throw missing('seller');
    const name = (await userNames(ctx, [scope.seller])).get(scope.seller) ?? 'Former member';
    return sellerMetric(b, metric, scope.seller, facts, sf.sellerByAccount, name);
  }
  if (kind === 'offer' && PRODUCT_METRICS.includes(metric)) {
    if (!scope.offer) throw unexplained();
    const o = b.offers.find((x) => x.id === scope.offer);
    if (!o) throw missing('offer');
    return productMetric(b, 'offer', metric, o.name, o.id);
  }
  if (kind === 'practice' && PRODUCT_METRICS.includes(metric)) {
    if (!scope.practice) throw unexplained();
    const p = (await listPractices(ctx, { includeArchived: true })).find((x) => x.id === scope.practice);
    if (!p) throw missing('practice');
    return productMetric(b, 'practice', metric, p.name, p.id);
  }
  throw unexplained();
}

/** `GET /analytics/metrics/{key}` (R3c-1 Rulings 12-13): what is behind one Overview number, under the caller's data limit. */
export async function metricDetail(ctx: ModuleContext, key: string, scope: MetricScope, opts: { now?: Date } = {}): Promise<MetricDetail> {
  const now = opts.now ?? new Date();
  const b = await overviewBasis(ctx, now);
  const sf = await sellerFacts(ctx, b, now);
  const r = await resolve(ctx, b, key, scope, sf);
  const byAccount = new Map(b.journeys.map((j) => [j.accountId, j]));
  const hits = [...new Map(r.hits.map((h) => [h.accountId, h])).values()].filter((h) => byAccount.has(h.accountId));
  const names = await accountNames(ctx, hits.map((h) => h.accountId));
  const top = hits.filter((h) => names.has(h.accountId)).sort((x, y) => y.at.getTime() - x.at.getTime() || x.accountId.localeCompare(y.accountId)).slice(0, 6);
  const sellerOfHit = (h: Hit) => sf.sellerByAccount.get(h.accountId);
  const sellerNames = await userNames(ctx, [...new Set((r.sections.includes('seller') ? hits : top).flatMap((h) => sellerOfHit(h) ?? []))]);
  const sellerName = (id: string) => sellerNames.get(id) ?? 'Former member';
  const offerName = (j: Journey) => b.offers.find((o) => o.id === j.offerId)?.name ?? null;
  const fmt = (n: number) => format(r.money ? 'money' : 'count', n);

  const group = (label: string, nameOf: (h: Hit, j: Journey) => string | null) => {
    const sums = new Map<string, number>();
    for (const h of hits) {
      const name = nameOf(h, byAccount.get(h.accountId)!);
      if (name) sums.set(name, (sums.get(name) ?? 0) + (r.money ? h.weight : 1));
    }
    const items = [...sums].filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 8);
    return { label, items: items.map(([name, n]) => ({ name, count: n, value: fmt(n) })) };
  };
  const breakdowns = r.sections
    .map((s) =>
      s === 'source'
        ? group('By source', (_, j) => b.sources.get(topSource(b, j.firstSourceId))?.name ?? null)
        : s === 'offer'
          ? group('By offer', (_, j) => offerName(j) ?? 'No offer')
          : group('By seller', (h) => (sellerOfHit(h) ? sellerName(sellerOfHit(h)!) : null)),
    )
    .filter((g) => g.items.length > 0);

  return {
    eyebrow: r.eyebrow,
    title: r.title,
    value: format(r.kind, r.value),
    change_pct: r.change,
    definition: r.definition,
    notes: r.notes,
    breakdowns,
    accounts: top.flatMap((h) => {
      const j = byAccount.get(h.accountId)!;
      const seller = sellerOfHit(h);
      const meta = [offerName(j), b.sources.get(j.firstSourceId)?.name, seller ? sellerName(seller) : null].filter(Boolean).join(' · ');
      return [{ account_id: h.accountId, name: names.get(h.accountId)!, meta, at: h.at.toISOString() }];
    }),
    total: hits.length,
    see_all: r.seeAll,
  };
}
