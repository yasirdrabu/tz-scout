import { eq, and } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as metricRoute } from '@/http/routes/v1/analytics/metrics/[key]/route';
import { analyticsJourneyArrival, analyticsJourneyDeal, analyticsJourneyScore, analyticsJourneyStage } from '@/modules/analytics';
import { createOffer, createPractice } from '@/modules/offers';
import { assignment, pipelineStage } from '@/modules/routing/db/schema';
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

function deliver<D>(c: ConsumerDef<D>, data: D, occurredAt: string): Promise<void> {
  return w.run((ctx) =>
    c.handle(
      { id: newId('evt'), type: c.event.type, schemaVersion: 1, tenantId: w.tenantId, occurredAt, actor: { kind: 'system', id: 'test' }, correlationId: newId('cor'), data: c.event.data.parse(data) },
      ctx,
    ),
  );
}
const arrived = (accountId: string, day: string) =>
  deliver(
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
const staged = (accountId: string, to: string, day: string) => deliver(analyticsJourneyStage, { accountId, from: 'arrived', to, causeEventId: newId('evt') }, at(day));
const dealt = (accountId: string, amountCents: number, day: string, status: 'open' | 'won' = 'open') =>
  deliver(
    analyticsJourneyDeal,
    { accountId, system: 'hubspot', dealExternalId: newId('evt'), status, previousStatus: null, stage: null, amountCents, currency: 'USD', openedAt: null, closedAt: status === 'won' ? at(day) : null, companyLifecycle: 'none', observedAt: at(day) },
    at(day),
  );
const scored = (accountId: string, offerId: string, practiceId: string, day: string) =>
  deliver(
    analyticsJourneyScore,
    { accountId, priority: 70, fit: 60, intent: 50, tier: 'good_fit', previousTier: null, bestOfferId: offerId, previousBestOfferId: null, practiceId, revenueBand: null, cause: 'new_signal', profileVersion: 1, version: 1_000_000 },
    at(day),
  );

const get = async (as: string, path: string, status = 200) => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  try {
    const res = await w.as(as, metricRoute, `analytics/metrics/${path}`);
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  } finally {
    vi.useRealTimers();
  }
};

let w: Workspace;
let ann: string;
let bob: string;
let offerId: string;
let practiceId: string;
let ids: string[];
let a8: string;

/**
 * Now is 2026-11-07 (Q4 2026). Seven accounts: a1..a4 are Ann's (own_accounts), a5..a7 Bob's; a7 arrived last quarter
 * and was reviewed at 2026-07-21. a1, a2, a3 are Reviewed; a1 is at Opportunity on an $84,000 deal; a5 is at Opportunity
 * on a $400 offer with no deal; a2 is Won. Ann accepted a1..a3 (a4 pending); Bob accepted a5. 'reviewed' has a target of 10.
 */
beforeAll(async () => {
  w = await workspace('Metric Co');
  ann = await w.person('seller', { name: 'Ann Seller', dataLimit: { kind: 'own_accounts' } });
  bob = await w.person('seller', { name: 'Bob Seller' });
  practiceId = (await w.run((ctx) => createPractice(ctx, { name: 'Metric Practice', slug: 'metric-practice' }))).id;
  offerId = (await w.run((ctx) => createOffer(ctx, { name: 'Metric Offer', practiceId, ...completeOffer, priceMinCents: 40_000 }))).id;
  await w.run((ctx) => ctx.tx.update(pipelineStage).set({ quarterTarget: 10 }).where(and(eq(pipelineStage.tenantId, ctx.tenantId), eq(pipelineStage.key, 'reviewed'))));
  ids = await Promise.all([1, 2, 3, 4, 5, 6, 7].map((i) => w.account(`Metric Co ${i}`)));
  const [a1, a2, a3, a4, a5, a6, a7] = ids as [string, string, string, string, string, string, string];
  for (const a of [a1, a2, a3, a4]) await setSummary(w.tenant, a, { ownerUserId: ann });
  for (const a of [a5, a6, a7]) await setSummary(w.tenant, a, { ownerUserId: bob });
  for (const [a, d] of [[a1, '2026-10-05'], [a2, '2026-10-10'], [a3, '2026-10-20'], [a4, '2026-10-22'], [a5, '2026-10-12'], [a6, '2026-10-13'], [a7, '2026-07-20']] as const) await arrived(a, d);
  await staged(a7, 'reviewed', '2026-07-21');
  await staged(a7, 'lost', '2026-07-25');
  await staged(a6, 'lost', '2026-10-30');
  a8 = await w.account('Metric Co 8');
  await arrived(a8, '2026-07-01');
  await staged(a8, 'opportunity', '2026-07-10');
  await dealt(a8, 500_000, '2026-07-20', 'won');
  await dealt(a8, 1_000_000, '2026-10-15', 'won');
  await staged(a1, 'reviewed', '2026-10-06');
  await staged(a2, 'reviewed', '2026-10-11');
  await staged(a3, 'reviewed', '2026-10-21');
  await staged(a1, 'opportunity', '2026-10-20');
  await dealt(a1, 8_400_000, '2026-10-20');
  await scored(a1, offerId, practiceId, '2026-10-21');
  await staged(a2, 'won', '2026-10-28');
  await staged(a5, 'opportunity', '2026-10-25');
  await scored(a5, offerId, practiceId, '2026-10-25');
  await w.run(async (ctx) => {
    const row = (accountId: string, sellerUserId: string, rest: object) => ({ id: newId('asg'), tenantId: ctx.tenantId, accountId, sellerUserId, assignedBy: w.owner, ...rest });
    const done = (day: string, h: number) => ({ assignedAt: new Date(at(day, '00:00')), respondedAt: new Date(new Date(at(day, '00:00')).getTime() + h * 3_600_000), acceptedHow: 'seller', status: 'accepted' });
    await ctx.tx.insert(assignment).values([
      row(a1, ann, done('2026-10-05', 2)),
      row(a2, ann, done('2026-10-10', 4)),
      row(a3, ann, done('2026-10-20', 6)),
      row(a4, ann, { assignedAt: new Date(at('2026-10-22')) }),
      row(a5, bob, done('2026-10-12', 30)),
      row(a6, bob, { assignedAt: new Date(at('2026-10-13')) }),
    ]);
  });
});

type Group = { label: string; items: { name: string; count: number; value: string }[] };

describe('GET /api/v1/analytics/metrics/{key} (R3c-1 Rulings 12 and 13)', () => {
  it('a stage: value, change against last quarter, notes, breakdowns, newest six accounts and the See all link', async () => {
    const d = await get(w.owner, 'stage?stage=reviewed');
    expect(d).toMatchObject({ eyebrow: 'Pipeline stage · this quarter', title: 'Reviewed', value: '4', change_pct: 100, total: 4, see_all: { stage: 'reviewed' } });
    expect(d.definition).toMatch(/Counts when: /);
    expect(d.notes).toEqual([
      { label: 'From Sent', value: '67% moved on' },
      { label: 'Still at Sent or left', value: '2' },
      { label: 'Quarter target', value: '10 · pace 4' },
    ]);
    expect(d.breakdowns.map((b: Group) => b.label)).toEqual(['By source', 'By offer']);
    expect(d.breakdowns[0].items.reduce((s: number, i: { count: number }) => s + i.count, 0)).toBe(4);
    expect(d.accounts.map((a: { name: string }) => a.name)).toEqual(['Metric Co 5', 'Metric Co 3', 'Metric Co 2', 'Metric Co 1']);
    expect(d.accounts[0]).toMatchObject({ account_id: ids[4], at: at('2026-10-25') });
    expect(d.accounts[0].meta).toContain('Metric Offer');
  });

  it('pipeline value is a money string with offer and seller breakdowns', async () => {
    const d = await get(w.owner, 'pipeline_value');
    expect(d).toMatchObject({ eyebrow: 'Pipeline · this quarter', title: 'Pipeline value', value: '$84k', change_pct: 744, total: 3, see_all: { stage: 'opportunity' } });
    expect(d.breakdowns.map((b: Group) => b.label)).toEqual(['By source', 'By offer', 'By seller']);
    expect(d.breakdowns.find((b: Group) => b.label === 'By offer').items).toEqual([{ name: 'Metric Offer', count: 8_440_000, value: '$84k' }]);
    expect(d.breakdowns.find((b: Group) => b.label === 'By seller').items).toEqual([
      { name: 'Ann Seller', count: 8_400_000, value: '$84k' },
      { name: 'Bob Seller', count: 40_000, value: '$400' },
    ]);
  });

  it('a seller cell shows the ratio and its denominator', async () => {
    const d = await get(w.owner, `seller.accepted?seller=${ann}`);
    expect(d).toMatchObject({ eyebrow: 'Ann Seller · seller', title: 'Accepted', value: '75%', change_pct: null, total: 3, see_all: { owner: ann } });
    expect(d.notes).toEqual([{ label: 'Assigned', value: '4' }, { label: 'Counted', value: '3' }]);
    expect(d.breakdowns.map((b: Group) => b.label)).toEqual(['By offer', 'By source']);
    expect((await get(w.owner, `seller.time_to_accept?seller=${ann}`)).value).toBe('4 h');
    expect((await get(w.owner, `seller.win_rate?seller=${ann}`)).value).toBe('50%');
  });

  it('an offer cell and a practice cell', async () => {
    const o = await get(w.owner, `offer.pipeline?offer=${offerId}`);
    expect(o).toMatchObject({ eyebrow: 'Metric Offer · offer', value: '$84k', see_all: { offer: offerId } });
    expect(o.breakdowns.map((b: Group) => b.label)).toEqual(['By source', 'By seller']);
    const p = await get(w.owner, `practice.opportunities?practice=${practiceId}`);
    expect(p).toMatchObject({ eyebrow: 'Metric Practice · practice', value: '2', see_all: { practice: practiceId } });
    expect(p.breakdowns.map((b: Group) => b.label)).toEqual(['By offer', 'By seller']);
  });

  it('the other tiles and an exit', async () => {
    expect(await get(w.owner, 'sent_to_won')).toMatchObject({ title: 'Sent to Won', value: '16.7%', total: 1, see_all: null, notes: [{ label: 'Entered', value: '6' }, { label: 'Counted', value: '1' }] });
    expect(await get(w.owner, 'days_to_win')).toMatchObject({ title: 'Days to win', value: '18', total: 1 });
    expect(await get(w.owner, 'won_value')).toMatchObject({ title: 'Won value', value: '$10k', change_pct: 100, total: 2, see_all: { stage: 'won' } });
    expect(await get(w.owner, 'exit?stage=lost')).toMatchObject({ eyebrow: 'Left the pipeline · this quarter', value: '1', change_pct: 0, total: 1 });
    expect(await get(w.owner, 'exit?stage=declined')).toMatchObject({ value: '0', change_pct: null, total: 0, accounts: [], breakdowns: [] });
  });

  it("never shows an account outside the caller's data limit", async () => {
    const d = await get(ann, 'stage?stage=reviewed');
    expect(d.total).toBe(3);
    expect(d.accounts.map((a: { account_id: string }) => a.account_id)).not.toContain(ids[4]);
    const cell = await get(ann, `seller.accepted?seller=${ann}`);
    expect(cell.accounts.map((a: { account_id: string }) => a.account_id)).not.toContain(ids[4]);
    const offer = await get(ann, `offer.pipeline?offer=${offerId}`);
    expect(offer.total).toBe(1);
    expect(offer.accounts.map((a: { account_id: string }) => a.account_id)).not.toContain(ids[4]);
  });

  it('a bad key or a missing scope is 400, an unknown stage or seller is 404', async () => {
    expect((await get(w.owner, 'nope', 400)).title).toBe("That number can't be explained.");
    await get(w.owner, 'stage', 400);
    await get(w.owner, 'seller.accepted', 400);
    await get(w.owner, 'stage?stage=nowhere', 404);
    await get(w.owner, 'exit?stage=reviewed', 404);
    await get(w.owner, `seller.accepted?seller=${w.owner}`, 404);
    await get(w.owner, 'offer.won?offer=off_nope', 404);
  });
});
