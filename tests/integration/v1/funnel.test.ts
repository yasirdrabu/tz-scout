import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as funnelRoute } from '@/http/routes/v1/analytics/funnel/route';
import { GET as drillRoute } from '@/http/routes/v1/analytics/sources/[id]/performance/route';
import { GET as bySourceRoute } from '@/http/routes/v1/costs/by-source/route';
import { GET as statsRoute } from '@/http/routes/v1/sources/stats/route';
import { addManualLine, analyticsJourneyArrival, analyticsJourneyDeal, analyticsJourneyScore, analyticsJourneyStage, recordLine, setTarget } from '@/modules/analytics';
import { addDays, dayOf } from '@/modules/analytics/domain/budgets';
import { registerSource } from '@/modules/intake';
import { batch } from '@/modules/intake/db/schema';
import { createOffer, createPractice } from '@/modules/offers';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import type { ConsumerDef } from '@/platform/runtime/consumers';
import { completeOffer } from '../offers/helpers';
import { arrivedAccount, resolved, setSummary } from '../routing/helpers';
import { workspace, type Workspace } from './review-helpers';

afterAll(closeDbs);
beforeEach(() => setPrincipalCacheTtl(0));

const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const dayAgo = (days: number) => addDays(dayOf(NOW, 'UTC'), -days);

let w: Workspace;
let seller: string;
let alpha: string;
let alphaList: string;
let beta: string;
let batchId: string;
let offerId: string;
let offerName: string;
let practiceId: string;
const acc: string[] = [];

const json = async (p: Promise<Response>, status = 200) => {
  const res = await p;
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  return body;
};

/** Delivers one event straight to an analytics consumer, as the worker would, at `occurredAt`. */
function deliver<D>(c: ConsumerDef<D>, data: D, occurredAt: string): Promise<void> {
  return w.run((ctx) =>
    c.handle(
      { id: newId('evt'), type: c.event.type, schemaVersion: 1, tenantId: w.tenantId, occurredAt, actor: { kind: 'system', id: 'test' }, correlationId: newId('cor'), data: c.event.data.parse(data) },
      ctx,
    ),
  );
}
const staged = (accountId: string, to: string, daysAgo: number) =>
  deliver(analyticsJourneyStage, { accountId, from: 'arrived', to, causeEventId: newId('evt') }, ago(daysAgo));
const arrivedAt = (accountId: string, chain: Record<string, string>, daysAgo: number, batch?: string) =>
  deliver(
    analyticsJourneyArrival,
    {
      arrivalId: newId('evt').replace('evt_', 'arr_'),
      ...(batch ? { batchId: batch } : {}),
      accountId,
      resolution: 'created',
      sourceChain: chain,
      isFirstFromSource: true,
      initialReviewStatusKey: 'unvetted',
      effectiveTrust: 0.6,
    },
    ago(daysAgo),
  );
const scored = (accountId: string, practice: string, offer: string) =>
  deliver(
    analyticsJourneyScore,
    {
      accountId,
      priority: 70,
      fit: 60,
      intent: 50,
      tier: 'good_fit',
      previousTier: null,
      bestOfferId: offer,
      previousBestOfferId: null,
      practiceId: practice,
      revenueBand: null,
      cause: 'new_signal',
      profileVersion: 1,
      version: 1_000_000,
    },
    ago(1),
  );
const wonDeal = (accountId: string, amountCents: number | null) =>
  deliver(
    analyticsJourneyDeal,
    {
      accountId,
      system: 'hubspot',
      dealExternalId: newId('evt'),
      status: 'won',
      previousStatus: null,
      stage: null,
      amountCents,
      currency: 'USD',
      openedAt: null,
      closedAt: ago(1),
      companyLifecycle: 'none',
      observedAt: ago(1),
    },
    ago(1),
  );
const source = (kind: 'person' | 'vendor' | 'list', name: string, parentId?: string) =>
  w.run(async (ctx) => (await registerSource(ctx, parentId ? { kind, name, parentId } : { kind, name })).id);

/**
 * Alpha (a person) sent 10 accounts and its list 2: acc 0 and 1 (the list's) won, 2 and 3 assigned, 4 and 5
 * reviewed (5 then lost), the rest only sent. Beta (a vendor) sent 3 now, one reviewed, and one 40 days ago.
 * Spend in 90 days: $3,000 on Alpha, $1,000 on acc 1 (rolls up to Alpha), $500 on Beta and $200 shared.
 */
beforeAll(async () => {
  w = await workspace('Funnel Co');
  seller = await w.person('seller', { name: 'Sam Seller', dataLimit: { kind: 'own_accounts' } });
  alpha = await source('person', 'Alpha');
  alphaList = await source('list', 'Alpha list', alpha);
  beta = await source('vendor', 'Beta');
  batchId = newId('bat');
  await w.run((ctx) => ctx.tx.insert(batch).values({ id: batchId, tenantId: ctx.tenantId, principal: 'test', name: 'Funnel batch' }));
  practiceId = (await w.run((ctx) => createPractice(ctx, { name: 'Funnel Practice', slug: 'funnel-practice' }))).id;
  offerName = 'Funnel Offer';
  offerId = (await w.run((ctx) => createOffer(ctx, { name: offerName, practiceId, ...completeOffer }))).id;

  for (let i = 0; i < 12; i++) {
    const chain = i === 1 || i === 11 ? { agentSourceId: alphaList } : { personSourceId: alpha };
    acc.push(await arrivedAccount(w.tenant, { name: `Alpha Co ${i}`, sourceChain: chain }));
  }
  for (const a of [acc[0]!, acc[1]!]) await staged(a, 'won', 2);
  for (const a of [acc[2]!, acc[3]!]) await staged(a, 'assigned', 3);
  for (const a of [acc[4]!, acc[5]!]) await staged(a, 'reviewed', 4);
  await staged(acc[5]!, 'lost', 3);
  await wonDeal(acc[0]!, 500_000);
  await wonDeal(acc[1]!, null);
  await scored(acc[0]!, practiceId, offerId);
  await arrivedAt(acc[2]!, { personSourceId: alpha }, 5, batchId);

  const b = [];
  for (let i = 0; i < 4; i++) b.push(await arrivedAccount(w.tenant, { name: `Beta Co ${i}`, sourceChain: { vendorSourceId: beta } }));
  await staged(b[0]!, 'reviewed', 2);
  await arrivedAt(b[3]!, { vendorSourceId: beta }, 40);

  await w.run(async (ctx) => {
    await addManualLine(ctx, { occurredOn: dayAgo(2), category: 'partner_fees', amountCents: 300_000, note: null, sourceId: alpha });
    await recordLine(ctx, { originEventId: newId('evt'), occurredOn: dayAgo(2), category: 'ai_usage', provider: 'anthropic', amountCents: 100_000, accountId: acc[1]!, sourceId: null });
    await addManualLine(ctx, { occurredOn: dayAgo(2), category: 'partner_fees', amountCents: 50_000, note: null, sourceId: beta });
    await addManualLine(ctx, { occurredOn: dayAgo(2), category: 'partner_fees', amountCents: 20_000, note: null });
    await setTarget(ctx, 250_000);
  });
  await setSummary(w.tenant, acc[0]!, { ownerUserId: seller });
});

describe('GET /api/v1/analytics/funnel (Ruling 10)', () => {
  it('a row per top-level source with counts, steps, spend, cost per won and status; the child rolls into its parent', async () => {
    const body = await json(w.as(w.owner, funnelRoute, 'analytics/funnel'));
    expect(body.period.key).toBe('90d');
    expect(body.stages.map((s: { key: string }) => s.key)).toEqual(['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity', 'won']);
    expect(body.stages[0]).toEqual({ key: 'arrived', name: 'Sent' });
    expect(body.target_cost_per_won_cents).toBe(250_000);
    expect(body.rows).toEqual([
      {
        source_id: alpha,
        name: 'Alpha',
        kind: 'person',
        counts: [12, 6, 4, 2, 2, 2],
        step_pct: [null, 50, 67, 50, 100, 100],
        cost_per_account_cents: [33_333, 66_667, 100_000, 200_000, 200_000, 200_000],
        spend_cents: 400_000,
        cost_per_won_cents: 200_000,
        status: 'good',
        win_rate_pct: 17,
      },
      {
        source_id: beta,
        name: 'Beta',
        kind: 'vendor',
        counts: [4, 1, 0, 0, 0, 0],
        step_pct: [null, 25, 0, null, null, null],
        cost_per_account_cents: [12_500, 50_000, null, null, null, null],
        spend_cents: 50_000,
        cost_per_won_cents: null,
        status: 'not_enough_data',
        win_rate_pct: 0,
      },
    ]);
    expect(body.totals).toEqual({ sent: 16, sources: 2, won: 2, won_pct: 13, spend_cents: 470_000, cost_per_won_cents: 235_000 });
    expect(body.shared_spend_cents).toBe(20_000);
    expect(typeof body.updated_at).toBe('string');
  });

  it('period=30d leaves out the account that arrived 40 days ago', async () => {
    const body = await json(w.as(w.owner, funnelRoute, 'analytics/funnel?period=30d'));
    expect(body.period.key).toBe('30d');
    expect(body.rows.find((r: { source_id: string }) => r.source_id === beta).counts[0]).toBe(3);
    expect(body.totals.sent).toBe(15);
  });

  it('practice, offer and batch each narrow the cohort', async () => {
    for (const q of [`practice=${practiceId}`, `offer=${offerId}`]) {
      const body = await json(w.as(w.owner, funnelRoute, `analytics/funnel?${q}`));
      expect(body.totals).toMatchObject({ sent: 1, won: 1, sources: 1 });
      expect(body.rows.map((r: { source_id: string }) => r.source_id)).toEqual([alpha]);
    }
    const byBatch = await json(w.as(w.owner, funnelRoute, `analytics/funnel?batch=${batchId}`));
    expect(byBatch.totals).toMatchObject({ sent: 1, won: 0 });
    expect(byBatch.rows[0].counts).toEqual([1, 1, 1, 0, 0, 0]);
  });

  it('spend is not split by practice, offer or batch: with any of them every spend field is null and spend_split is false', async () => {
    expect((await json(w.as(w.owner, funnelRoute, 'analytics/funnel'))).spend_split).toBe(true);
    for (const q of [`practice=${practiceId}`, `offer=${offerId}`, `batch=${batchId}`]) {
      const body = await json(w.as(w.owner, funnelRoute, `analytics/funnel?${q}`));
      expect(body.spend_split).toBe(false);
      expect(body.totals).toMatchObject({ spend_cents: null, cost_per_won_cents: null });
      expect(body).toMatchObject({ shared_spend_cents: null });
      for (const r of body.rows) expect(r).toMatchObject({ cost_per_account_cents: null, spend_cents: null, cost_per_won_cents: null, status: null });
    }
    const drill = await json(w.as(w.owner, drillRoute, `analytics/sources/${alpha}/performance?practice=${practiceId}`));
    expect(drill.spend_split).toBe(false);
    expect(drill.totals).toMatchObject({ sent: 1, spend_cents: null, cost_per_sent_cents: null, cost_per_won_cents: null, status: null });
    expect(drill.stages[0].cost_each_cents).toBeNull();
    expect(drill.rank).toBeNull();
    expect((await json(w.as(w.owner, drillRoute, `analytics/sources/${alpha}/performance`))).spend_split).toBe(true);
  });

  it('refuses an unknown period', async () => {
    await json(w.as(w.owner, funnelRoute, 'analytics/funnel?period=week'), 400);
  });

  it('a seller with own_accounts sees only their accounts, every spend field null, and /costs/by-source is 403', async () => {
    const body = await json(w.as(seller, funnelRoute, 'analytics/funnel'));
    expect(body.totals).toEqual({ sent: 1, sources: 1, won: 1, won_pct: 100, spend_cents: null, cost_per_won_cents: null });
    expect(body.rows).toEqual([
      {
        source_id: alpha,
        name: 'Alpha',
        kind: 'person',
        counts: [1, 1, 1, 1, 1, 1],
        step_pct: [null, 100, 100, 100, 100, 100],
        cost_per_account_cents: null,
        spend_cents: null,
        cost_per_won_cents: null,
        status: null,
        win_rate_pct: 100,
      },
    ]);
    expect(body).toMatchObject({ shared_spend_cents: null, target_cost_per_won_cents: null });
    await json(w.as(seller, bySourceRoute, 'costs/by-source'), 403);
  });
});

describe('GET /api/v1/analytics/sources/{id}/performance (Ruling 11)', () => {
  it("Alpha's totals, rank, neighbours, insight, stages, batches and won accounts by value", async () => {
    const body = await json(w.as(w.owner, drillRoute, `analytics/sources/${alpha}/performance`));
    expect(body.source).toEqual({ id: alpha, name: 'Alpha', kind: 'person' });
    expect(body).toMatchObject({ rank: 1, of: 1, prev_id: null, next_id: beta, position: 1, row_count: 2, target_cost_per_won_cents: 250_000 });
    expect(body.totals).toEqual({
      sent: 12,
      won: 2,
      won_pct: 17,
      all_won_pct: 13,
      spend_cents: 400_000,
      cost_per_sent_cents: 33_333,
      cost_per_won_cents: 200_000,
      status: 'good',
    });
    expect(body.insight).toBe('Most accounts stall between Sent and Reviewed.');
    expect(body.stages[0]).toEqual({ key: 'arrived', name: 'Sent', count: 12, all_count: 16, moved_on_pct: null, all_moved_on_pct: null, lost: 0, cost_each_cents: 33_333 });
    expect(body.stages[1]).toEqual({ key: 'reviewed', name: 'Reviewed', count: 6, all_count: 7, moved_on_pct: 50, all_moved_on_pct: 44, lost: 1, cost_each_cents: 66_667 });
    expect(body.stages.map((s: { key: string }) => s.key)).toEqual(['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity', 'won']);
    expect(body.batches).toEqual([{ batch_id: batchId, name: 'Funnel batch', sent: 1, won: 0 }]);
    expect(body.won_accounts).toHaveLength(2);
    expect(body.won_accounts[0]).toEqual({ account_id: acc[0], name: 'Alpha Co 0', offer_name: offerName, value_cents: 500_000 });
    expect(body.won_accounts[1]).toMatchObject({ account_id: acc[1], name: 'Alpha Co 1', value_cents: null });
  });

  it('Beta is too early to judge and has no rank; a child source has no rank or neighbours', async () => {
    const b = await json(w.as(w.owner, drillRoute, `analytics/sources/${beta}/performance`));
    expect(b).toMatchObject({ rank: null, of: 1, prev_id: alpha, next_id: null, insight: 'Too early to judge.' });
    // The second funnel row: "2 of {rows}".
    const rows = (await json(w.as(w.owner, funnelRoute, 'analytics/funnel'))).rows;
    expect(rows[1].source_id).toBe(beta);
    expect(b).toMatchObject({ position: 2, row_count: rows.length });
    const child = await json(w.as(w.owner, drillRoute, `analytics/sources/${alphaList}/performance`));
    expect(child).toMatchObject({ rank: null, prev_id: null, next_id: null, position: null, row_count: null, totals: { sent: 2, won: 1 } });
    expect(child.totals.spend_cents).toBe(100_000);
  });

  it('spend fields are null without costs:read', async () => {
    const body = await json(w.as(seller, drillRoute, `analytics/sources/${alpha}/performance`));
    expect(body.totals).toMatchObject({ sent: 1, spend_cents: null, cost_per_sent_cents: null, cost_per_won_cents: null, status: null });
    expect(body.stages[0].cost_each_cents).toBeNull();
    expect(body).toMatchObject({ rank: null, target_cost_per_won_cents: null });
  });

  it('is 404 for an unknown source', async () => {
    await json(w.as(w.owner, drillRoute, 'analytics/sources/src_nope/performance'), 404);
  });
});

describe('GET /api/v1/sources/stats from journeys (Ruling 13)', () => {
  let c: string;
  let d: string;

  beforeAll(async () => {
    c = await source('person', 'Cara');
    d = await source('person', 'Dev');
    const both = await arrivedAccount(w.tenant, { name: 'Both Co', sourceChain: { personSourceId: c } });
    await resolved(w.tenant, both, { sourceChain: { personSourceId: d } });
    const wonThenLost = await arrivedAccount(w.tenant, { name: 'Won Then Lost Co', sourceChain: { personSourceId: c } });
    await staged(wonThenLost, 'won', 3);
    await staged(wonThenLost, 'lost', 2);
    await w.run((ctx) => addManualLine(ctx, { occurredOn: dayAgo(300), category: 'partner_fees', amountCents: 10_000, note: null, sourceId: c }));
  });

  const statOf = (body: { data: { source_id: string }[] }, id: string) => body.data.find((s) => s.source_id === id) as Record<string, unknown>;

  it('counts an account under its first source only, and a won account that later lost as won, with all-time spend', async () => {
    const body = await json(w.as(w.owner, statsRoute, 'sources/stats'));
    expect(statOf(body, c)).toMatchObject({ sent: 2, reviewed: 1, assigned: 1, won: 1, spend_cents: 10_000, cost_per_won_cents: 10_000 });
    expect(statOf(body, d)).toMatchObject({ sent: 0, won: 0, spend_cents: 0, cost_per_won_cents: null });
  });

  it("a caller without costs:read gets null spend and cost per won", async () => {
    const manager = await w.person('seller', { name: 'Sources Seller', dataLimit: { kind: 'all' }, extra: ['sources:manage'] });
    const body = await json(w.as(manager, statsRoute, 'sources/stats'));
    expect(statOf(body, c)).toMatchObject({ spend_cents: null, cost_per_won_cents: null });
  });
});
