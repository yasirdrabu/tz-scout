import { eq, and } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as overviewRoute } from '@/http/routes/v1/analytics/overview/route';
import { analyticsJourneyArrival, analyticsJourneyDeal, analyticsJourneyScore, analyticsJourneyStage, overview } from '@/modules/analytics';
import { createOffer, createPractice } from '@/modules/offers';
import { pipelineStage } from '@/modules/routing/db/schema';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import type { ConsumerDef } from '@/platform/runtime/consumers';
import { completeOffer } from '../offers/helpers';
import { setSummary } from '../routing/helpers';
import { call, keyFor } from '../v1/intake-helpers';
import { workspace, type Workspace } from '../v1/review-helpers';

afterAll(closeDbs);
beforeEach(() => setPrincipalCacheTtl(0));

const NOW = new Date('2026-11-07T12:00:00.000Z');
const at = (day: string) => `${day}T10:00:00.000Z`;

let w: Workspace;
let seller: string;

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
const dealt = (accountId: string, status: 'open' | 'won', amountCents: number | null, day: string) =>
  deliver(
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

const json = async (p: Promise<Response>, status = 200) => {
  const res = await p;
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  return body;
};

/**
 * Now is 2026-11-07 (Q4 2026, week 6 of 14). Visible to the seller: a1, a2, a3 arrived this quarter, a4 last
 * quarter, a5 last quarter and won this quarter. a1 is at Opportunity with two open deals (one with no amount) on a
 * 50000 offer; a2 won; a3 is Lost this quarter. A sixth account, won this quarter, belongs to someone else.
 */
beforeAll(async () => {
  w = await workspace('Overview Co');
  seller = await w.person('seller', { name: 'Sam Seller', dataLimit: { kind: 'own_accounts' } });
  const practiceId = (await w.run((ctx) => createPractice(ctx, { name: 'Overview Practice', slug: 'overview-practice' }))).id;
  const offerId = (await w.run((ctx) => createOffer(ctx, { name: 'Priced Offer', practiceId, ...completeOffer, priceMinCents: 50_000 }))).id;
  await w.run((ctx) => ctx.tx.update(pipelineStage).set({ quarterTarget: 10 }).where(and(eq(pipelineStage.tenantId, ctx.tenantId), eq(pipelineStage.key, 'reviewed'))));

  const [a1, a2, a3, a4, a5, hidden] = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => w.account(`Overview Co ${i}`)));
  for (const a of [a1!, a2!, a3!, a4!, a5!]) await setSummary(w.tenant, a, { ownerUserId: seller });

  await arrived(a1!, '2026-10-05');
  await arrived(a2!, '2026-10-10');
  await arrived(a3!, '2026-10-20');
  await arrived(a4!, '2026-09-10');
  await arrived(a5!, '2026-08-20');
  await arrived(hidden!, '2026-10-12');

  await staged(a1!, 'reviewed', '2026-10-06');
  await staged(a1!, 'opportunity', '2026-10-20');
  await dealt(a1!, 'open', 120_000, '2026-10-20');
  await dealt(a1!, 'open', null, '2026-10-21');
  await deliver(
    analyticsJourneyScore,
    { accountId: a1!, priority: 70, fit: 60, intent: 50, tier: 'good_fit', previousTier: null, bestOfferId: offerId, previousBestOfferId: null, practiceId, revenueBand: null, cause: 'new_signal', profileVersion: 1, version: 1_000_000 },
    at('2026-10-21'),
  );
  await staged(a2!, 'won', '2026-10-28');
  await dealt(a2!, 'won', null, '2026-10-28');
  await staged(a3!, 'lost', '2026-11-01');
  await staged(a5!, 'won', '2026-10-25');
  await dealt(a5!, 'won', 200_000, '2026-10-25');
  await staged(hidden!, 'won', '2026-10-15');
  await dealt(hidden!, 'won', 900_000, '2026-10-15');
});

/** Runs `fn` with `Date` frozen at NOW, as the route reads the clock. */
async function atNow<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

describe('GET /api/v1/analytics/overview (R3c-1 Rulings 1-6 and 11)', () => {
  it('a seller sees the quarter, bands, pace, exits and tiles of their five accounts; the sixth is counted nowhere', async () => {
    const body = await atNow(() => json(w.as(seller, overviewRoute, 'analytics/overview')));
    expect(body.quarter).toEqual({ label: 'Q4 2026', from: '2026-10-01', to: '2026-11-07', week: 6, weeks: 14, pace_pct: 41 });
    expect(body.first_stage).toEqual({ key: 'arrived', name: 'Sent' });
    expect(body.opportunity_stage).toEqual({ key: 'opportunity', name: 'Opportunity' });
    expect(body.won_stage).toEqual({ key: 'won', name: 'Won' });
    expect(body.stages).toEqual([
      { key: 'arrived', name: 'Sent', count: 3, pct_of_previous: null, value_cents: null, target: null, expected: null, pace: null },
      { key: 'reviewed', name: 'Reviewed', count: 3, pct_of_previous: 100, value_cents: null, target: 10, expected: 4, pace: 'behind' },
      { key: 'assigned', name: 'Assigned', count: 3, pct_of_previous: 100, value_cents: null, target: null, expected: null, pace: null },
      { key: 'engaged', name: 'Engaged', count: 3, pct_of_previous: 100, value_cents: null, target: null, expected: null, pace: null },
      { key: 'opportunity', name: 'Opportunity', count: 3, pct_of_previous: 100, value_cents: 170_000, target: null, expected: null, pace: null },
      { key: 'won', name: 'Won', count: 2, pct_of_previous: 67, value_cents: 200_000, target: null, expected: null, pace: null },
    ]);
    expect(body.exits).toEqual([
      { key: 'declined', name: 'Disqualified', count: 0 },
      { key: 'back_to_nurture', name: 'Back to nurture', count: 0 },
      { key: 'lost', name: 'Lost', count: 1 },
    ]);
    expect(body.kpis).toEqual({
      pipeline_value_cents: 170_000,
      pipeline_accounts: 1,
      won_value_cents: 200_000,
      won_accounts: 2,
      sent_to_won_pct: 33.3,
      days_to_win: 42,
    });
    expect(typeof body.updated_at).toBe('string');
  });

  it('the owner, with no data limit, also sees the sixth account', async () => {
    const v = await w.run((ctx) => overview(ctx, { now: NOW }));
    expect(v.stages.find((s) => s.key === 'won')).toMatchObject({ count: 3, value_cents: 1_100_000 });
    expect(v.kpis.won_accounts).toBe(3);
  });

  it('an empty workspace has zeros, null percentages and no days to win', async () => {
    const empty = await workspace('Empty Co');
    const body = await atNow(() => json(empty.as(empty.owner, overviewRoute, 'analytics/overview')));
    expect(body.stages.every((s: { count: number; pct_of_previous: number | null }) => s.count === 0 && s.pct_of_previous === null)).toBe(true);
    expect(body.exits.every((e: { count: number }) => e.count === 0)).toBe(true);
    expect(body.kpis).toEqual({ pipeline_value_cents: 0, pipeline_accounts: 0, won_value_cents: 0, won_accounts: 0, sent_to_won_pct: null, days_to_win: null });
    expect(body.updated_at).toBeNull();
  });

  it('is 401 without auth, 403 without analytics:read and 200 for a seller', async () => {
    expect((await overviewRoute(new Request('http://x/api/v1/analytics/overview'))).status).toBe(401);
    const noRead = await keyFor(w.tenant, ['accounts:read']);
    expect((await call(overviewRoute, noRead, 'analytics/overview')).status).toBe(403);
    expect((await w.as(seller, overviewRoute, 'analytics/overview')).status).toBe(200);
  });
});
