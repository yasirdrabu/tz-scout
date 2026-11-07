import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as scorecardRoute } from '@/http/routes/v1/analytics/scorecard/route';
import { analyticsJourneyArrival, analyticsJourneyDeal, analyticsJourneyScore, analyticsJourneyStage } from '@/modules/analytics';
import { activity } from '@/modules/crm/db/schema';
import { approveOffer, archiveOffer, createOffer, createPractice } from '@/modules/offers';
import { accountPlan, planStep, playbookTemplate } from '@/modules/playbooks/db/schema';
import { assignment } from '@/modules/routing/db/schema';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import type { ConsumerDef } from '@/platform/runtime/consumers';
import { completeOffer } from '../offers/helpers';
import { setSummary } from '../routing/helpers';
import { workspace, type Workspace } from '../v1/review-helpers';

afterAll(closeDbs);
beforeEach(() => setPrincipalCacheTtl(0));

const NOW = new Date('2026-11-07T12:00:00.000Z');
const at = (day: string, time = '10:00') => `${day}T${time}:00.000Z`;

function deliver<D>(w: Workspace, c: ConsumerDef<D>, data: D, occurredAt: string): Promise<void> {
  return w.run((ctx) =>
    c.handle(
      { id: newId('evt'), type: c.event.type, schemaVersion: 1, tenantId: w.tenantId, occurredAt, actor: { kind: 'system', id: 'test' }, correlationId: newId('cor'), data: c.event.data.parse(data) },
      ctx,
    ),
  );
}
const arrived = (w: Workspace, accountId: string, day: string) =>
  deliver(
    w,
    analyticsJourneyArrival,
    {
      arrivalId: newId('evt').replace('evt_', 'arr_'),
      accountId,
      resolution: 'created',
      sourceChain: { agentSourceId: w.source.agentId },
      isFirstFromSource: true,
      initialReviewStatusKey: 'unvetted',
      effectiveTrust: 0.6,
    },
    at(day),
  );
const staged = (w: Workspace, accountId: string, to: string, day: string) => deliver(w, analyticsJourneyStage, { accountId, from: 'arrived', to, causeEventId: newId('evt') }, at(day));
const dealt = (w: Workspace, accountId: string, status: 'open' | 'won', amountCents: number | null, day: string) =>
  deliver(
    w,
    analyticsJourneyDeal,
    {
      accountId,
      system: 'hubspot',
      dealExternalId: newId('evt'),
      status,
      previousStatus: null,
      stage: null,
      amountCents,
      currency: 'USD',
      openedAt: null,
      closedAt: status === 'won' ? at(day) : null,
      companyLifecycle: 'none',
      observedAt: at(day),
    },
    at(day),
  );
const scored = (w: Workspace, accountId: string, offerId: string, practiceId: string, day: string) =>
  deliver(
    w,
    analyticsJourneyScore,
    { accountId, priority: 70, fit: 60, intent: 50, tier: 'good_fit', previousTier: null, bestOfferId: offerId, previousBestOfferId: null, practiceId, revenueBand: null, cause: 'new_signal', profileVersion: 1, version: 1_000_000 },
    at(day),
  );

const json = async (p: Promise<Response>, status = 200) => {
  const res = await p;
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  return body;
};

async function atNow<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

let w: Workspace;
let ann: string; // seller A, under own_accounts
let bob: string; // seller B

const hours = (day: string, h: number) => ({
  assignedAt: new Date(at(day, '00:00')),
  respondedAt: new Date(new Date(at(day, '00:00')).getTime() + h * 3_600_000),
  acceptedHow: 'seller',
  status: 'accepted',
});

/**
 * Ann: a1..a4 assigned (a1 2h, a2 4h, a3 6h accepted, a4 pending); a1 at Opportunity (open deal 120000, two meetings),
 * a2 Won. Bob: a5 (accepted after 30h, at Opportunity on a 50000 offer, no deal) and a6 (pending).
 * Ann has one step on time; Bob has two, one late.
 */
beforeAll(async () => {
  w = await workspace('Scorecard Co');
  ann = await w.person('seller', { name: 'Ann Seller', dataLimit: { kind: 'own_accounts' } });
  bob = await w.person('seller', { name: 'Bob Seller' });
  const practiceId = (await w.run((ctx) => createPractice(ctx, { name: 'Scorecard Practice', slug: 'scorecard-practice' }))).id;
  const offerId = (await w.run((ctx) => createOffer(ctx, { name: 'Scorecard Offer', practiceId, ...completeOffer, priceMinCents: 50_000 }))).id;
  const [a1, a2, a3, a4, a5, a6] = (await Promise.all([1, 2, 3, 4, 5, 6].map((i) => w.account(`Scorecard Co ${i}`)))) as [string, string, string, string, string, string];
  for (const a of [a1, a2, a3, a4]) await setSummary(w.tenant, a, { ownerUserId: ann });
  for (const a of [a5, a6]) await setSummary(w.tenant, a, { ownerUserId: bob });
  const days: [string, string][] = [[a1, '2026-10-05'], [a2, '2026-10-10'], [a3, '2026-10-20'], [a4, '2026-10-22'], [a5, '2026-10-12'], [a6, '2026-10-13']];
  for (const [a, d] of days) await arrived(w, a, d);

  await staged(w, a1, 'opportunity', '2026-10-20');
  await dealt(w, a1, 'open', 120_000, '2026-10-20');
  await scored(w, a1, offerId, practiceId, '2026-10-21');
  await staged(w, a2, 'won', '2026-10-28');
  await staged(w, a5, 'opportunity', '2026-10-25');
  await scored(w, a5, offerId, practiceId, '2026-10-25');

  await w.run(async (ctx) => {
    const row = (accountId: string, sellerUserId: string, rest: object) => ({ id: newId('asg'), tenantId: ctx.tenantId, accountId, sellerUserId, assignedBy: w.owner, ...rest });
    await ctx.tx.insert(assignment).values([
      row(a1, ann, hours('2026-10-05', 2)),
      row(a2, ann, hours('2026-10-10', 4)),
      row(a3, ann, hours('2026-10-20', 6)),
      row(a4, ann, { assignedAt: new Date(at('2026-10-22')) }),
      row(a5, bob, hours('2026-10-12', 30)),
      row(a6, bob, { assignedAt: new Date(at('2026-10-13')) }),
    ]);
    await ctx.tx.insert(activity).values(
      ['2026-10-10', '2026-10-12'].map((d) => ({ id: newId('cac'), tenantId: ctx.tenantId, accountId: a1, system: 'hubspot', externalId: `m-${d}`, kind: 'meeting', occurredAt: new Date(at(d)) })),
    );
    const templateId = newId('plb');
    await ctx.tx.insert(playbookTemplate).values({ id: templateId, tenantId: ctx.tenantId, name: 'Standard' });
    const plan = async (accountId: string) => {
      const id = newId('pln');
      await ctx.tx.insert(accountPlan).values({ id, tenantId: ctx.tenantId, accountId, templateId, templateVersion: 1, assignmentId: newId('asg'), stopWhen: 'reply_or_meeting', startDate: '2026-10-01' });
      return id;
    };
    const step = (planId: string, ownerUserId: string, order: number, dueDate: string, doneAt: string | null) => ({
      id: newId('stp'), tenantId: ctx.tenantId, planId, order, day: 0, channel: 'email', ownerRole: 'seller', ownerUserId, title: 'Step', dueDate,
      status: 'done', doneAt: doneAt ? new Date(doneAt) : null,
    });
    const annPlan = await plan(a1);
    const bobPlan = await plan(a5);
    await ctx.tx.insert(planStep).values([
      step(annPlan, ann, 1, '2026-10-15', at('2026-10-14')),
      step(bobPlan, bob, 1, '2026-10-20', at('2026-10-20')),
      step(bobPlan, bob, 2, '2026-10-22', at('2026-10-25')),
      { ...step(bobPlan, bob, 3, '2026-11-07', null), status: 'todo' }, // due today and open: not late yet, so not counted
    ]);
  });
});

const cell = (value: number | null, tone: string | null, sub?: string) => ({ value, tone, ...(sub ? { sub } : {}) });

describe('GET /api/v1/analytics/scorecard (R3c-1 Rulings 7-11)', () => {
  it('by seller: counts, hours, steps, win rate, and tone against the pooled team', async () => {
    const body = await atNow(() => json(w.as(w.owner, scorecardRoute, 'analytics/scorecard?tab=sellers')));
    expect(body.tab).toBe('sellers');
    expect(body.quarter_label).toBe('Q4 2026');
    // team: accepted 4 of 6, 42 hours over 4, steps 2 of 3, 1 won of 3 opportunities
    expect(body.team).toEqual({ accepted: 67, time_to_accept: 11, steps_on_time: 67, win_rate: 33 });
    expect(body.rows).toEqual([
      {
        seller_user_id: ann,
        name: 'Ann Seller',
        assigned: 4,
        accepted: cell(75, 'good', '3 of 4'),
        time_to_accept: cell(4, 'good', 'Average'),
        steps_on_time: cell(100, 'good', 'Playbook steps'),
        meetings: cell(2, null),
        opportunities: cell(2, null),
        won: cell(1, null),
        pipeline_cents: cell(120_000, null),
        win_rate: cell(50, 'good', 'Of opportunities'),
      },
      {
        seller_user_id: bob,
        name: 'Bob Seller',
        assigned: 2,
        accepted: cell(50, 'attention', '1 of 2'),
        time_to_accept: cell(30, 'attention', 'Average'),
        steps_on_time: cell(50, 'attention', 'Playbook steps'),
        meetings: cell(0, null),
        opportunities: cell(1, null),
        won: cell(0, null),
        pipeline_cents: cell(50_000, null),
        win_rate: cell(0, 'attention', 'Of opportunities'),
      },
    ]);
  });

  it('a seller under own_accounts gets their own row only, with no team colour', async () => {
    const body = await atNow(() => json(w.as(ann, scorecardRoute, 'analytics/scorecard?tab=sellers')));
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ seller_user_id: ann, assigned: 4, accepted: cell(75, null, '3 of 4'), time_to_accept: cell(4, null, 'Average'), win_rate: cell(50, null, 'Of opportunities') });
  });

  it('by offer and by practice: archived offers with no numbers are absent, win rate is coloured, lead and counts show', async () => {
    const o = await workspace('Scorecard Offers Co');
    const practiceId = (await o.run((ctx) => createPractice(ctx, { name: 'Lead Practice', slug: 'lead-practice', leadUserId: o.owner }))).id;
    await o.run((ctx) => createPractice(ctx, { name: 'Empty Practice', slug: 'empty-practice' }));
    const busy = (await o.run((ctx) => createOffer(ctx, { name: 'Busy Offer', practiceId, ...completeOffer, priceModel: 'fixed', priceMinCents: 50_000 }))).id;
    await o.run((ctx) => approveOffer(ctx, busy));
    await o.run((ctx) => createOffer(ctx, { name: 'Quiet Offer', practiceId, ...completeOffer }));
    const old = (await o.run((ctx) => createOffer(ctx, { name: 'Old Offer', practiceId, ...completeOffer }))).id;
    await o.run((ctx) => archiveOffer(ctx, old));

    const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => o.account(`Offers Co ${i}`)));
    for (const [i, a] of ids.entries()) {
      await arrived(o, a, '2026-10-05');
      await scored(o, a, busy, practiceId, '2026-10-06');
      if (i < 2) await staged(o, a, 'won', '2026-10-20');
      if (i === 2) await staged(o, a, 'opportunity', '2026-10-21');
    }
    await dealt(o, ids[0]!, 'won', 100_000, '2026-10-20');
    await dealt(o, ids[1]!, 'won', null, '2026-10-20');
    // won last quarter, a second deal closed this quarter: adds to Won value, not to Won
    const late = await o.account('Offers Co late');
    await arrived(o, late, '2026-09-10');
    await scored(o, late, busy, practiceId, '2026-09-11');
    await staged(o, late, 'won', '2026-09-20');
    await dealt(o, late, 'won', 70_000, '2026-10-22');

    const offers = await atNow(() => json(o.as(o.owner, scorecardRoute, 'analytics/scorecard?tab=offers')));
    expect(offers.team).toBeNull();
    expect(offers.rows.map((r: { name: string }) => r.name)).toEqual(['Busy Offer', 'Quiet Offer']);
    expect(offers.rows[0]).toEqual({
      offer_id: busy,
      name: 'Busy Offer',
      practice_name: 'Lead Practice',
      price_label: 'Fixed fee · $500',
      matched: cell(10, null),
      opportunities: cell(3, null),
      won: cell(2, null),
      win_rate: cell(20, 'good', 'Of matched'),
      won_value_cents: cell(220_000, null),
      pipeline_cents: cell(50_000, null),
    });
    expect(offers.rows[1]).toMatchObject({ matched: cell(0, null), win_rate: cell(null, null, 'Of matched'), won_value_cents: cell(0, null) });

    const practices = await atNow(() => json(o.as(o.owner, scorecardRoute, 'analytics/scorecard?tab=practices')));
    expect(practices.rows.map((r: { name: string }) => r.name)).toEqual(['Lead Practice', 'Empty Practice']);
    expect(practices.rows[0]).toEqual({
      practice_id: practiceId,
      name: 'Lead Practice',
      lead_name: o.ownerName,
      offers: 2,
      active_offers: 1,
      matched: cell(10, null),
      opportunities: cell(3, null),
      won: cell(2, null),
      win_rate: cell(20, 'good', 'Of matched'),
      won_value_cents: cell(220_000, null),
      pipeline_cents: cell(50_000, null),
    });
    expect(practices.rows[1]).toMatchObject({ lead_name: null, offers: 0, active_offers: 0 });
  });

  it('a missing or unknown tab is a 400 with the tab names', async () => {
    for (const q of ['?tab=nope', '']) {
      const body = await json(w.as(w.owner, scorecardRoute, `analytics/scorecard${q}`), 400);
      expect(JSON.stringify(body)).toContain('Choose a tab: sellers, offers or practices.');
    }
  });
});
