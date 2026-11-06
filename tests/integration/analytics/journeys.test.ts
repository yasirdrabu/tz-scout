import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analyticsJourneyArrival,
  analyticsJourneyDeal,
  analyticsJourneyMerge,
  analyticsJourneyScore,
  analyticsJourneyStage,
  backfillJourneys,
  loadJourneys,
  type Journey,
} from '@/modules/analytics';
import { journey, journeyDeal, journeyStage } from '@/modules/analytics/db/schema';
import { account } from '@/modules/accounts/db/schema';
import { hubspotMock, pollDeals, recordLink, seedMockCrm } from '@/modules/crm';
import { mockAddDeal, mockSetDeal } from '@/modules/crm/fixtures';
import { submitArrival } from '@/modules/intake';
import { moveStage } from '@/modules/routing';
import { accountScored } from '@/modules/scoring/contracts/events';
import { closeDbs } from '@/platform/db/client';
import type { ConsumerDef } from '@/platform/runtime/consumers';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, freshTenant, personAndAgent, validArrival, type Tenant } from '../intake/helpers';

let t: Tenant;
beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
});
afterAll(closeDbs);

const T0 = '2026-10-01T10:00:00.000Z';
const T1 = '2026-10-02T10:00:00.000Z';
const T2 = '2026-10-03T10:00:00.000Z';
const T3 = '2026-10-04T10:00:00.000Z';
const T4 = '2026-10-05T10:00:00.000Z';

/** Delivers one event straight to an analytics consumer, as the worker would, with the given `occurredAt`. */
function deliver<D>(c: ConsumerDef<D>, data: D, occurredAt: string, tn: Tenant = t): Promise<void> {
  return tn.run((ctx) =>
    c.handle(
      { id: newId('evt'), type: c.event.type, schemaVersion: 1, tenantId: tn.tenantId, occurredAt, actor: { kind: 'system', id: 'test' }, correlationId: newId('cor'), data: c.event.data.parse(data) },
      ctx,
    ),
  );
}

const arrived = (accountId: string, sourceChain: Record<string, string>, occurredAt: string, batchId?: string) =>
  deliver(
    analyticsJourneyArrival,
    {
      arrivalId: newId('evt').replace('evt_', 'arr_'),
      ...(batchId ? { batchId } : {}),
      accountId,
      resolution: 'created',
      sourceChain,
      isFirstFromSource: true,
      initialReviewStatusKey: 'unvetted',
      effectiveTrust: 0.6,
    },
    occurredAt,
  );

const staged = (accountId: string, to: string, occurredAt: string) =>
  deliver(analyticsJourneyStage, { accountId, from: 'arrived', to, causeEventId: newId('evt') }, occurredAt);

const dealt = (accountId: string, dealExternalId: string, status: 'open' | 'won' | 'lost', amountCents: number | null, observedAt: string) =>
  deliver(
    analyticsJourneyDeal,
    {
      accountId,
      system: 'hubspot',
      dealExternalId,
      status,
      previousStatus: null,
      stage: null,
      amountCents,
      currency: 'USD',
      openedAt: null,
      closedAt: status === 'open' ? null : observedAt,
      companyLifecycle: 'none',
      observedAt,
    },
    observedAt,
  );

const scored = (accountId: string, version: number, practiceId: string, bestOfferId: string) =>
  deliver(
    analyticsJourneyScore,
    {
      accountId,
      priority: 70,
      fit: 60,
      intent: 50,
      tier: 'good_fit',
      previousTier: null,
      bestOfferId,
      previousBestOfferId: null,
      practiceId,
      revenueBand: null,
      cause: 'new_signal',
      profileVersion: 1,
      version,
    },
    T1,
  );

const journeyOf = async (accountId: string, tn: Tenant = t): Promise<Journey | undefined> =>
  (await tn.run((ctx) => loadJourneys(ctx))).find((j) => j.accountId === accountId);

const newAccount = () => newId('acc');

describe('arrival', () => {
  it('the first arrival names the agent as first source; a later one keeps it; an earlier one delivered late replaces it', async () => {
    const id = newAccount();
    await arrived(id, { personSourceId: 'src_p1', agentSourceId: 'src_a1', vendorSourceId: 'src_v1' }, T2, 'bat_1');
    expect(await journeyOf(id)).toMatchObject({ firstSourceId: 'src_a1', firstBatchId: 'bat_1', arrivedAt: new Date(T2) });

    await arrived(id, { personSourceId: 'src_p2' }, T3);
    expect(await journeyOf(id)).toMatchObject({ firstSourceId: 'src_a1', firstBatchId: 'bat_1', arrivedAt: new Date(T2) });

    await arrived(id, { vendorSourceId: 'src_v0' }, T1);
    expect(await journeyOf(id)).toMatchObject({ firstSourceId: 'src_v0', firstBatchId: null, arrivedAt: new Date(T1) });
  });
});

describe('stages', () => {
  it('a late stage event keeps the earlier entry', async () => {
    const id = newAccount();
    await arrived(id, { personSourceId: 'src_p1' }, T0);
    await staged(id, 'reviewed', T2);
    expect((await journeyOf(id))!.stages.get('reviewed')).toEqual(new Date(T2));
    await staged(id, 'reviewed', T1);
    expect((await journeyOf(id))!.stages.get('reviewed')).toEqual(new Date(T1));
    await staged(id, 'reviewed', T3);
    expect((await journeyOf(id))!.stages.get('reviewed')).toEqual(new Date(T1));
  });

  it('a move to an exit sets the exit; a later flow move clears it; an older exit delivered late does not bring it back', async () => {
    const id = newAccount();
    await arrived(id, { personSourceId: 'src_p1' }, T0);
    await staged(id, 'declined', T2);
    expect(await journeyOf(id)).toMatchObject({ exitStage: 'declined', exitAt: new Date(T2) });
    await staged(id, 'reviewed', T3);
    expect(await journeyOf(id)).toMatchObject({ exitStage: null, exitAt: null });
    await staged(id, 'declined', T1);
    expect(await journeyOf(id)).toMatchObject({ exitStage: null, exitAt: null });
    expect((await journeyOf(id))!.stages.get('declined')).toEqual(new Date(T1));
  });

  it('an older exit delivered after a later flow move it never saw does not set the exit', async () => {
    const id = newAccount();
    await arrived(id, { personSourceId: 'src_p1' }, T0);
    await staged(id, 'reviewed', T3);
    await staged(id, 'declined', T1);
    expect(await journeyOf(id)).toMatchObject({ exitStage: null, exitAt: null });
  });

  it('an exit before the arrival is kept', async () => {
    const id = newAccount();
    await staged(id, 'declined', T2);
    await arrived(id, { personSourceId: 'src_p1' }, T1);
    expect(await journeyOf(id)).toMatchObject({ exitStage: 'declined', exitAt: new Date(T2) });
  });

  it('a stage event before the arrival still stores its entry', async () => {
    const id = newAccount();
    await staged(id, 'reviewed', T2);
    await arrived(id, { personSourceId: 'src_p1' }, T1);
    expect((await journeyOf(id))!.stages.get('reviewed')).toEqual(new Date(T2));
  });
});

describe('scoring', () => {
  it('account.scored sets the practice and the best offer', async () => {
    const id = newAccount();
    await arrived(id, { personSourceId: 'src_p1' }, T0);
    await deliver(
      analyticsJourneyScore,
      {
        accountId: id,
        priority: 70,
        fit: 60,
        intent: 50,
        tier: 'good_fit',
        previousTier: null,
        bestOfferId: 'off_1',
        previousBestOfferId: null,
        practiceId: 'prc_1',
        revenueBand: null,
        cause: 'new_signal',
        profileVersion: 1,
        version: 1,
      },
      T1,
    );
    expect(await journeyOf(id)).toMatchObject({ practiceId: 'prc_1', offerId: 'off_1' });
  });

  it('an older score delivered late keeps the newer practice and offer', async () => {
    const id = newAccount();
    await arrived(id, { personSourceId: 'src_p1' }, T0);
    await scored(id, 3, 'prc_3', 'off_3');
    await scored(id, 2, 'prc_2', 'off_2');
    expect(await journeyOf(id)).toMatchObject({ practiceId: 'prc_3', offerId: 'off_3' });
  });

  it('a score before the arrival is kept', async () => {
    const id = newAccount();
    await scored(id, 1, 'prc_early', 'off_early');
    expect(await journeyOf(id)).toBeUndefined(); // no arrival yet
    await arrived(id, { personSourceId: 'src_p1' }, T1);
    expect(await journeyOf(id)).toMatchObject({ firstSourceId: 'src_p1', practiceId: 'prc_early', offerId: 'off_early' });
  });
});

describe('deals', () => {
  it('an older deal event is ignored', async () => {
    const id = newAccount();
    await arrived(id, { personSourceId: 'src_p1' }, T0);
    const deal = newId('evt');
    await dealt(id, deal, 'won', 500_000, T2);
    await dealt(id, deal, 'open', null, T1);
    expect((await journeyOf(id))!.deals).toEqual([{ status: 'won', amountCents: 500_000, closedAt: new Date(T2) }]);
    await dealt(id, deal, 'lost', 0, T3);
    expect((await journeyOf(id))!.deals).toEqual([{ status: 'lost', amountCents: 0, closedAt: new Date(T3) }]);
  });
});

describe('merge', () => {
  it('the survivor keeps the earlier arrival, the earliest stage entries and both accounts\' deals; the merged journey is gone', async () => {
    const survivor = newAccount();
    const merged = newAccount();
    await arrived(survivor, { agentSourceId: 'src_a1' }, T2, 'bat_s');
    await arrived(merged, { personSourceId: 'src_p9' }, T1, 'bat_m');
    await staged(survivor, 'reviewed', T3);
    await staged(merged, 'reviewed', T2);
    await staged(merged, 'assigned', T4);
    await dealt(survivor, newId('evt'), 'open', 1_000, T3);
    await dealt(merged, newId('evt'), 'won', 2_000, T4);

    const merge = () => deliver(analyticsJourneyMerge, { survivorId: survivor, mergedId: merged, mergedBy: 'usr_1' }, T4);
    await merge();
    await merge(); // a redelivery changes nothing

    const s = (await journeyOf(survivor))!;
    expect(s).toMatchObject({ firstSourceId: 'src_p9', firstBatchId: 'bat_m', arrivedAt: new Date(T1) });
    expect(s.stages).toEqual(new Map([['reviewed', new Date(T2)], ['assigned', new Date(T4)]]));
    expect(s.deals.map((d) => d.amountCents).sort()).toEqual([1_000, 2_000]);
    expect(await journeyOf(merged)).toBeUndefined();
    const left = await t.run((ctx) => ctx.tx.select().from(journeyStage).where(eq(journeyStage.accountId, merged)));
    expect(left).toEqual([]);
  });
});

describe('backfill', () => {
  /** Dates within a few seconds count as the same: the live path stamps the event, the backfill reads the row written beside it. */
  const close = (a: Date | null, b: Date | null) => (a === null || b === null ? a === b : Math.abs(a.getTime() - b.getTime()) < 5_000);
  const same = (a: Journey[], b: Journey[]) => {
    const by = (js: Journey[]) => [...js].sort((x, y) => x.accountId.localeCompare(y.accountId));
    const [x, y] = [by(a), by(b)];
    expect(y.map((j) => j.accountId)).toEqual(x.map((j) => j.accountId));
    x.forEach((j, i) => {
      const k = y[i]!;
      expect({ ...k, arrivedAt: null, exitAt: null, stages: [...k.stages.keys()].sort() }).toEqual({ ...j, arrivedAt: null, exitAt: null, stages: [...j.stages.keys()].sort() });
      expect(close(j.arrivedAt, k.arrivedAt) && close(j.exitAt, k.exitAt)).toBe(true);
      for (const [key, at] of j.stages) expect(close(at, k.stages.get(key)!)).toBe(true);
    });
  };

  it('rebuilds the journeys of accounts made before the consumers; a second run changes nothing', async () => {
    const b = await freshTenant();
    await runOutbox(b.tenantId);
    await b.run((ctx) => seedMockCrm(ctx));
    const { agentId } = await personAndAgent(b, 'Backfill');
    const { personId: other } = await personAndAgent(b, 'Other');

    // Two accounts through intake; the first also arrives later from a second source.
    const bodies = [validArrival(), validArrival()];
    for (const body of bodies) await asSource(b, agentId, (ctx) => submitArrival(ctx, body, { channel: 'api', canDeclareWarmIntro: false }));
    await runOutbox(b.tenantId);
    await asSource(b, other, (ctx) => submitArrival(ctx, bodies[0], { channel: 'api', canDeclareWarmIntro: false }));
    await runOutbox(b.tenantId);
    const ids = await b.run(async (ctx) => {
      const out: string[] = [];
      for (const body of bodies) out.push((await ctx.tx.select().from(account).where(eq(account.domain, body.account.domain)))[0]!.id);
      return out;
    });
    const [first, second] = ids as [string, string];

    // Stage moves, a score with a practice and an offer, and a won deal.
    await b.run((ctx) => moveStage(ctx, first, 'reviewed', newId('evt')));
    await b.run((ctx) => moveStage(ctx, second, 'declined', newId('evt')));
    await runOutbox(b.tenantId);
    await publishTestEvent(b.tenantId, accountScored, {
      accountId: first,
      priority: 80,
      fit: 70,
      intent: 60,
      tier: 'act_now',
      previousTier: null,
      bestOfferId: 'off_backfill',
      previousBestOfferId: null,
      practiceId: 'prc_backfill',
      revenueBand: null,
      cause: 'manual_rescore',
      profileVersion: 1,
      version: 1_000,
    });
    await runOutbox(b.tenantId);
    const co = await b.run((ctx) => hubspotMock(ctx).upsertCompany({ domain: bodies[0]!.account.domain, name: 'Backfill Co', ownerExternalId: null, replaceableOwner: true, properties: {} }));
    await b.run((ctx) => recordLink(ctx, { scoutType: 'account', scoutId: first, system: 'hubspot', externalId: co.externalId }));
    const ext = await b.run((ctx) => mockAddDeal(ctx, { companyExternalId: co.externalId, name: 'Backfill deal', amountCents: 300_000 }));
    await b.run((ctx) => pollDeals(ctx, new Date()));
    await runOutbox(b.tenantId);
    await b.run((ctx) => mockSetDeal(ctx, ext, { status: 'won', amountCents: 400_000 }));
    await b.run((ctx) => pollDeals(ctx, new Date()));
    await runOutbox(b.tenantId);

    const live = await b.run((ctx) => loadJourneys(ctx));
    expect(live.map((j) => j.accountId).sort()).toEqual([...ids].sort());
    const f = live.find((j) => j.accountId === first)!;
    expect(f).toMatchObject({ firstSourceId: agentId, practiceId: 'prc_backfill', offerId: 'off_backfill', exitStage: null });
    expect(f.stages.has('reviewed')).toBe(true);
    expect(f.deals).toEqual([{ status: 'won', amountCents: 400_000, closedAt: expect.any(Date) }]);
    expect(live.find((j) => j.accountId === second)).toMatchObject({ exitStage: 'declined' });

    // As if the consumers had never run.
    await b.run(async (ctx) => {
      await ctx.tx.delete(journeyStage);
      await ctx.tx.delete(journeyDeal);
      await ctx.tx.delete(journey);
    });
    expect(await b.run((ctx) => loadJourneys(ctx))).toEqual([]);

    expect(await b.run((ctx) => backfillJourneys(ctx))).toBe(2);
    same(live, await b.run((ctx) => loadJourneys(ctx)));
    const once = await b.run((ctx) => loadJourneys(ctx));
    expect(await b.run((ctx) => backfillJourneys(ctx))).toBe(0);
    expect(await b.run((ctx) => loadJourneys(ctx))).toEqual(once);
  }, 60_000);
});
