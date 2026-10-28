import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// A test can name accounts whose scoring throws; every other account scores as usual.
const failing = vi.hoisted(() => new Set<string>());
vi.mock('@/modules/scoring/services/score', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/scoring/services/score')>();
  return {
    ...real,
    scoreAccount: (...args: Parameters<typeof real.scoreAccount>) => {
      if (failing.has(args[1])) throw new Error('boom');
      return real.scoreAccount(...args);
    },
  };
});

import '@/entry/compose';
import { mergeAccounts, upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { account } from '@/modules/accounts/db/schema';
import { accountUpdated, signalRecorded } from '@/modules/accounts/contracts/events';
import { getArrival, intakeSourceInfo, registerSource, submitArrival } from '@/modules/intake';
import { arrivalRejected, arrivalResolved, sourceTrustChanged } from '@/modules/intake/contracts/events';
import { approveOffer, archiveOffer, createOffer, createPractice, listApprovedOffers } from '@/modules/offers';
import { offerChanged } from '@/modules/offers/contracts/events';
import { getScore, requestRescore, scoreAccount, updateProfile } from '@/modules/scoring';
import { accountScore, offerMatch, scoreChange } from '@/modules/scoring/db/schema';
import { ageingPage, rescoreAccounts } from '@/modules/scoring/services/rescore';
import type { ModuleContext } from '@/platform/context';
import { adminDb, closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { completeOffer, freshTenant } from '../offers/helpers';

afterAll(closeDbs);
afterEach(() => {
  vi.restoreAllMocks();
  failing.clear();
});

type Tenant = Awaited<ReturnType<typeof freshTenant>>;
const NOW = new Date('2026-10-27T12:00:00Z');
const DAY = 86_400_000;
const domain = () => `${newId('acc').slice(-10).toLowerCase()}-example.com`;
const slug = (p: string) => `${p}-${newId('prc').slice(-8).toLowerCase()}`;

function arrival(over: Partial<ArrivalForAccounts> = {}): ArrivalForAccounts {
  return {
    arrivalId: newId('evt').replace('evt_', 'arr_'),
    receivedAt: new Date('2026-10-26T15:00:00Z'),
    sourceChain: {},
    account: {},
    people: [],
    signals: [],
    facts: [],
    research: {},
    soleProprietor: false,
    externalIds: [],
    ...over,
  };
}

async function world() {
  const t = await freshTenant();
  await runOutbox(t.tenantId);
  const practice = await t.run((ctx) => createPractice(ctx, { name: 'Rescore Practice', slug: slug('p') }));
  return { t, practice };
}

async function approved(t: Tenant, practiceId: string, name: string, over: Record<string, unknown> = {}) {
  const o = await t.run((ctx) => createOffer(ctx, { name, practiceId, ...completeOffer, ...over }));
  await t.run((ctx) => approveOffer(ctx, o.id));
  return o;
}

/** An account made the way an arrival makes one, so its events carry an arrival id. */
const seed = (t: Tenant, practiceIds: string[] = [], rest: Partial<ArrivalForAccounts> = {}) =>
  t.run(async (ctx) => {
    const r = await upsertFromArrival(ctx, arrival({ account: { name: 'Rescore Co', domain: domain(), industry: 'Logistics' }, ...rest }));
    if (practiceIds.length) await ctx.tx.update(account).set({ practiceIds }).where(eq(account.id, r.accountId));
    return r;
  });

const score = (t: Tenant, id: string) => t.run((ctx) => scoreAccount(ctx, id, 'manual_rescore', undefined, { now: NOW }));
const current = (t: Tenant, id: string) =>
  t.run(async (ctx) => (await ctx.tx.select().from(accountScore).where(and(eq(accountScore.tenantId, ctx.tenantId), eq(accountScore.accountId, id))))[0]);
const changes = (t: Tenant, id: string) =>
  t.run((ctx) => ctx.tx.select().from(scoreChange).where(and(eq(scoreChange.tenantId, ctx.tenantId), eq(scoreChange.accountId, id))));
const matchRows = (t: Tenant, id: string) => t.run((ctx) => ctx.tx.select().from(offerMatch).where(eq(offerMatch.accountId, id)));
const outboxOf = async (t: Tenant, type: string) =>
  (
    (await adminDb.execute(
      sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = ${type} order by seq`,
    )) as unknown as { payload: { id: string; data: Record<string, unknown> } }[]
  ).map((r) => r.payload);
const scoredEvents = async (t: Tenant, accountId: string) =>
  (await outboxOf(t, 'scoring.account.scored')).filter((p) => p.data.accountId === accountId).map((p) => p.data);

describe('single-account triggers (SCO-E5-S1)', () => {
  it('AC1: an arrival of several items scores once, from intake.arrival.resolved, not once per fact', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    const a = await seed(t, [], {
      people: [
        { firstName: 'Ada', lastName: 'One', title: 'CTO' },
        { firstName: 'Bo', lastName: 'Two', title: 'CIO' },
      ],
      signals: [{ kind: 'trigger', type: 'funding', title: 'Series B', occurredAt: new Date(NOW.getTime() - 5 * DAY) }],
      facts: [
        { key: 'employees', value: 300 },
        { key: 'hq_country', value: 'US' },
      ],
    });
    await runOutbox(t.tenantId);
    // The account events carry the arrival id, so scoring leaves them to the resolved event.
    expect(await current(t, a.accountId)).toBeUndefined();
    await publishTestEvent(t.tenantId, arrivalResolved, {
      arrivalId: 'arr_one',
      accountId: a.accountId,
      resolution: 'created',
      sourceChain: {},
      isFirstFromSource: true,
      initialReviewStatusKey: 'unvetted',
      effectiveTrust: 0.6,
    });
    await runOutbox(t.tenantId);
    const resolvedId = (await outboxOf(t, 'intake.arrival.resolved'))[0]!.id;
    const rows = await changes(t, a.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.causeEventId).toBe(resolvedId);
    expect(await scoredEvents(t, a.accountId)).toHaveLength(1);
  });

  it('a recorded signal without an arrival id scores the account with cause new_signal', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    const a = await seed(t);
    await publishTestEvent(t.tenantId, signalRecorded, { accountId: a.accountId, signalId: 'sig_1', type: null, kind: 'trigger', occurredAt: null, sourceChain: {} });
    await runOutbox(t.tenantId);
    const rows = await changes(t, a.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cause).toBe('new_signal');
  });

  it('an arrival rejected as excluded, with an account id, is scored', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    const a = await seed(t);
    await runOutbox(t.tenantId);
    expect(await current(t, a.accountId)).toBeUndefined();
    await publishTestEvent(t.tenantId, arrivalRejected, { arrivalId: 'arr_x', reason: 'excluded', detail: 'Already a customer', accountId: a.accountId });
    await runOutbox(t.tenantId);
    expect(await current(t, a.accountId)).toBeDefined();
  });

  it('SCO-E1-S1-AC2b: a practice change rescores', async () => {
    const { t, practice } = await world();
    const other = await t.run((ctx) => createPractice(ctx, { name: 'Other', slug: slug('o') }));
    await approved(t, practice.id, 'One');
    await approved(t, other.id, 'Two');
    await runOutbox(t.tenantId);
    const a = await seed(t);
    await score(t, a.accountId);
    expect(await matchRows(t, a.accountId)).toHaveLength(2);
    await t.run((ctx) => ctx.tx.update(account).set({ practiceIds: [practice.id] }).where(eq(account.id, a.accountId)));
    await publishTestEvent(t.tenantId, accountUpdated, { accountId: a.accountId, changedKeys: ['practice_ids'] });
    await runOutbox(t.tenantId);
    expect(await matchRows(t, a.accountId)).toHaveLength(1);
  });
});

describe('fan-out on offers (SCO-E5-S2)', () => {
  it('AC1: approving an offer rescores its practice and accounts with no practice; best-offer changes carry previousBestOfferId', async () => {
    const { t, practice } = await world();
    const other = await t.run((ctx) => createPractice(ctx, { name: 'Other', slug: slug('o') }));
    const weak = await approved(t, practice.id, 'Weak', { industries: ['healthcare'] });
    await runOutbox(t.tenantId);
    const inPractice = await seed(t, [practice.id]);
    const noPractice = await seed(t);
    const elsewhere = await seed(t, [other.id]);
    for (const a of [inPractice, noPractice, elsewhere]) await score(t, a.accountId);
    const strong = await approved(t, practice.id, 'Strong');
    await runOutbox(t.tenantId);
    for (const a of [inPractice, noPractice]) {
      expect((await current(t, a.accountId))!.bestOfferId).toBe(strong.id);
      const events = await scoredEvents(t, a.accountId);
      expect(events[events.length - 1]).toMatchObject({ bestOfferId: strong.id, previousBestOfferId: weak.id });
    }
    expect((await current(t, elsewhere.accountId))!.version).toBe(1);
  });

  it('AC2 and Review Focus 2: archiving the best offer of three accounts leaves none with an archived best offer', async () => {
    const { t, practice } = await world();
    const other = await t.run((ctx) => createPractice(ctx, { name: 'Other', slug: slug('o') }));
    const best = await approved(t, practice.id, 'Best');
    const second = await approved(t, other.id, 'Second', { industries: ['healthcare'] });
    await runOutbox(t.tenantId);
    const noPractice = await seed(t);
    const onlyOffer = await seed(t, [practice.id]);
    const both = await seed(t, [practice.id, other.id]);
    for (const a of [noPractice, onlyOffer, both]) {
      await score(t, a.accountId);
      expect((await current(t, a.accountId))!.bestOfferId).toBe(best.id);
    }
    await t.run((ctx) => archiveOffer(ctx, best.id));
    await runOutbox(t.tenantId);
    for (const a of [noPractice, onlyOffer, both]) {
      expect((await current(t, a.accountId))!.bestOfferId).not.toBe(best.id);
      expect((await matchRows(t, a.accountId)).map((m) => m.offerId)).not.toContain(best.id);
    }
    expect((await current(t, noPractice.accountId))!.bestOfferId).toBe(second.id);
    const orphan = await current(t, onlyOffer.accountId);
    expect(orphan).toMatchObject({ bestOfferId: null, tier: 'not_fit', priority: 0 });
    expect((orphan!.explanation as { lines: { text?: string }[] }).lines.map((l) => l.text)).toContain('No approved offer to match against.');
    expect((await scoredEvents(t, onlyOffer.accountId)).pop()).toMatchObject({ previousBestOfferId: best.id, bestOfferId: null });
  });

  it('Review Focus 2 under concurrency: a rescore that loaded offers before the archive and commits after it does not keep the archived best offer', async () => {
    const { t, practice } = await world();
    const best = await approved(t, practice.id, 'Best');
    await runOutbox(t.tenantId);
    const a = await seed(t, [practice.id]);
    const stale = await t.run((ctx) => listApprovedOffers(ctx));
    expect(stale.map((o) => o.id)).toContain(best.id);
    await t.run((ctx) => archiveOffer(ctx, best.id));

    // The slow job scores with the list it loaded before the archive and has not committed when the archive is delivered.
    let delivered: Promise<void> = Promise.resolve();
    await t.run(async (ctx) => {
      await scoreAccount(ctx, a.accountId, 'manual_rescore', undefined, { now: NOW, offers: stale });
      delivered = runOutbox(t.tenantId);
      await new Promise((r) => setTimeout(r, 1500));
    });
    await delivered;
    expect((await current(t, a.accountId))!.bestOfferId).not.toBe(best.id);
    expect((await matchRows(t, a.accountId)).map((m) => m.offerId)).not.toContain(best.id);
  }, 30_000);

  it('offer.changed rescores only when it affects matching, and skips the practice page once the offer is not approved', async () => {
    const { t, practice } = await world();
    const o = await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    const a = await seed(t);
    await score(t, a.accountId);
    expect((await current(t, a.accountId))!.version).toBe(1);
    const pages = async () => (await outboxOf(t, 'jobs.scoring.rescore.page')).length;
    const setOffer = (patch: ReturnType<typeof sql>) => t.run((ctx) => ctx.tx.execute(sql`update offers.offer ${patch} where id = ${o.id}`));
    const changed = (affectsMatching: boolean) =>
      publishTestEvent(t.tenantId, offerChanged, { offerId: o.id, practiceId: practice.id, changed: ['industries'], affectsMatching });

    await setOffer(sql`set industries = array['healthcare']::text[]`);
    let before = await pages();
    await changed(false);
    await runOutbox(t.tenantId);
    expect(await pages()).toBe(before);
    expect((await current(t, a.accountId))!.version).toBe(1);

    await changed(true);
    await runOutbox(t.tenantId);
    // One page job for accounts holding a match, one for the practice and accounts with no practice.
    expect(await pages()).toBe(before + 2);
    expect((await current(t, a.accountId))!.version).toBe(2);

    await setOffer(sql`set status = 'archived'`);
    before = await pages();
    await changed(true);
    await runOutbox(t.tenantId);
    expect(await pages()).toBe(before + 1);
    expect((await current(t, a.accountId))!.bestOfferId).toBeNull();
  });
});

describe('fan-out on trust and rules', () => {
  it('SCO-E5-S2-AC3: a trust change rescores only that source accounts', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    vi.spyOn(intakeSourceInfo, 'getTrust').mockResolvedValue(0.6);
    const [agentA, agentB] = await t.run(async (ctx) => {
      const person = await registerSource(ctx, { kind: 'person', name: 'Ash' });
      const a = await registerSource(ctx, { kind: 'agent', name: 'Agent A', parentId: person.id });
      const b = await registerSource(ctx, { kind: 'agent', name: 'Agent B', parentId: person.id });
      return [a.id, b.id] as const;
    });
    const send = async (sourceId: string) => {
      const sent = await t.run((ctx) =>
        submitArrival(
          { ...ctx, access: { sourceId, dataLimit: { kind: 'own_source' } } },
          { account: { name: 'Trust Co', domain: domain(), industry: 'Logistics' } },
          { channel: 'api' },
        ),
      );
      await runOutbox(t.tenantId);
      return (await t.run((ctx) => getArrival(ctx, sent.arrivalId)))!.accountId!;
    };
    const accA = await send(agentA);
    const accB = await send(agentB);
    expect((await current(t, accA))!.trustModifier).toBe(0);
    vi.spyOn(intakeSourceInfo, 'getTrust').mockResolvedValue(0.9);
    await publishTestEvent(t.tenantId, sourceTrustChanged, { sourceId: agentA, level: 'agent', from: 0.6, to: 0.9, sampleSize: 20, cause: 'outcomes' });
    await runOutbox(t.tenantId);
    expect((await current(t, accA))!.trustModifier).toBe(5);
    expect((await current(t, accB))!.trustModifier).toBe(0);
    expect((await changes(t, accA)).some((c) => c.cause === 'trust_changed')).toBe(true);
  });

  it('SCO-E3-S1-AC4: a threshold change moves tiers after the jobs run', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    const a = await seed(t);
    await score(t, a.accountId);
    expect((await current(t, a.accountId))!.tier).not.toBe('not_fit');
    await t.run((ctx) => updateProfile(ctx, { tierThresholds: { notFitBelow: 100 } }));
    await runOutbox(t.tenantId);
    expect(await current(t, a.accountId)).toMatchObject({ tier: 'not_fit', profileVersion: 2 });
    expect((await changes(t, a.accountId)).map((c) => c.cause)).toContain('rules_changed');
  });
});

describe('ageing', () => {
  it('rescores accounts with a young signal that were never scored or last scored over 20 hours ago, and no others', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    const young = [{ kind: 'trigger' as const, type: 'funding', title: 'Series B', occurredAt: new Date(NOW.getTime() - 5 * DAY) }];
    const stale = await seed(t, [], { signals: young });
    const fresh = await seed(t, [], { signals: young });
    const neverScored = await seed(t, [], { signals: young });
    const noSignal = await seed(t);
    const oldSignal = await seed(t, [], { signals: [{ kind: 'trigger', type: 'funding', title: 'Old news', occurredAt: new Date(NOW.getTime() - 400 * DAY) }] });
    for (const a of [stale, fresh, noSignal, oldSignal]) await score(t, a.accountId);
    await t.run((ctx) =>
      ctx.tx.execute(
        sql`update scoring.account_score set computed_at = ${NOW.toISOString()}::timestamptz - interval '30 hours' where account_id in (${stale.accountId}, ${noSignal.accountId}, ${oldSignal.accountId})`,
      ),
    );
    const sentBefore = (await outboxOf(t, 'jobs.scoring.rescore.accounts')).length;
    await t.run((ctx) => ageingPage(ctx, undefined, NOW));
    const ids = (await outboxOf(t, 'jobs.scoring.rescore.accounts')).slice(sentBefore).flatMap((j) => j.data.accountIds as string[]);
    expect(ids.sort()).toEqual([stale.accountId, neverScored.accountId].sort());
  });
});

describe('a failing account', () => {
  it('does not undo the other scores: it is queued again on its own', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    const [one, bad, three] = [await seed(t), await seed(t), await seed(t)];
    failing.add(bad.accountId);
    const sentBefore = (await outboxOf(t, 'jobs.scoring.rescore.accounts')).length;
    await t.run((ctx) => rescoreAccounts(ctx, [one.accountId, bad.accountId, three.accountId], 'manual_rescore'));
    expect(await current(t, one.accountId)).toBeDefined();
    expect(await current(t, three.accountId)).toBeDefined();
    expect(await current(t, bad.accountId)).toBeUndefined();
    const followUps = (await outboxOf(t, 'jobs.scoring.rescore.accounts')).slice(sentBefore);
    expect(followUps.map((j) => j.data.accountIds)).toEqual([[bad.accountId]]);
  });

  it('a lone failing account fails the message so the normal retries apply', async () => {
    const { t } = await world();
    const bad = await seed(t);
    failing.add(bad.accountId);
    await expect(t.run((ctx) => rescoreAccounts(ctx, [bad.accountId], 'manual_rescore'))).rejects.toThrow('boom');
  });
});

describe('paging', () => {
  it('450 accounts in a practice enqueue three rescore jobs of 200, 200 and 50', async () => {
    const { t, practice } = await world();
    await t.run((ctx) =>
      ctx.tx.execute(sql`
        insert into accounts.account (id, tenant_id, name, match_name, domain, practice_ids)
        select 'acc_pg' || lpad(i::text, 6, '0'), ${ctx.tenantId}, 'Page ' || i, 'page ' || i, 'pg' || i || '-example.com', array[${practice.id}]::text[]
        from generate_series(1, 450) i`),
    );
    await seed(t); // outside the practice filter
    await runOutbox(t.tenantId);
    await t.run((ctx) => requestRescore(ctx, { practiceId: practice.id }));
    await runOutbox(t.tenantId);
    const jobs = await outboxOf(t, 'jobs.scoring.rescore.accounts');
    expect(jobs.map((j) => (j.data.accountIds as string[]).length)).toEqual([200, 200, 50]);
    expect(await t.run((ctx) => ctx.tx.select().from(accountScore))).toHaveLength(450);
  }, 120_000);
});

describe('merge', () => {
  it('scores the survivor with the merged account warm intro and drops the merged score rows', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    const agentId = await t.run(async (ctx) => {
      const person = await registerSource(ctx, { kind: 'person', name: 'Ash' });
      return (await registerSource(ctx, { kind: 'agent', name: 'Ash agent', parentId: person.id })).id;
    });
    const sent = await t.run((ctx) =>
      submitArrival(
        { ...ctx, access: { sourceId: agentId, dataLimit: { kind: 'own_source' } } },
        { account: { name: 'Warm Co', domain: domain(), industry: 'Logistics' }, warm_intro: { introducer_name: 'Ash', relationship_key: 'event_meeting' } },
        { channel: 'api', canDeclareWarmIntro: true },
      ),
    );
    await runOutbox(t.tenantId);
    const mergedId = (await t.run((ctx) => getArrival(ctx, sent.arrivalId)))!.accountId!;
    const survivor = await seed(t);
    await score(t, survivor.accountId);
    expect((await current(t, mergedId))!.warmPoints).toBeGreaterThan(0);
    expect((await current(t, survivor.accountId))!.warmPoints).toBe(0);
    const person = { userId: 'usr_leader', sourceId: 'src_leader', dataLimit: { kind: 'all' as const } };
    await t.run((ctx) => mergeAccounts({ ...ctx, access: person } as ModuleContext, survivor.accountId, mergedId));
    await runOutbox(t.tenantId);
    expect(await current(t, mergedId)).toBeUndefined();
    expect(await matchRows(t, mergedId)).toHaveLength(0);
    expect((await current(t, survivor.accountId))!.warmPoints).toBeGreaterThan(0);
    expect(await t.run((ctx) => getScore(ctx, survivor.accountId))).toMatchObject({ accountId: survivor.accountId });
  });
});

describe('requestRescore', () => {
  it('refuses a practice and a source together', async () => {
    const { t, practice } = await world();
    await expect(t.run((ctx) => requestRescore(ctx, { practiceId: practice.id, sourceId: 'src_one' }))).rejects.toMatchObject({
      status: 400,
      message: 'Choose a practice or a source, not both.',
    });
  });
});

describe('scoring with merged ids', () => {
  it('alsoAccountIds brings the merged account warm intro and trust chains into the survivor score, with no other consumer involved', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    vi.spyOn(intakeSourceInfo, 'getTrust').mockResolvedValue(0.9);
    const agentId = await t.run(async (ctx) => {
      const person = await registerSource(ctx, { kind: 'person', name: 'Ash' });
      return (await registerSource(ctx, { kind: 'agent', name: 'Ash agent', parentId: person.id })).id;
    });
    const sent = await t.run((ctx) =>
      submitArrival(
        { ...ctx, access: { sourceId: agentId, dataLimit: { kind: 'own_source' } } },
        { account: { name: 'Warm Co', domain: domain(), industry: 'Logistics' }, warm_intro: { introducer_name: 'Ash', relationship_key: 'event_meeting' } },
        { channel: 'api', canDeclareWarmIntro: true },
      ),
    );
    await runOutbox(t.tenantId);
    const otherId = (await t.run((ctx) => getArrival(ctx, sent.arrivalId)))!.accountId!;
    const survivor = await seed(t);
    const alone = await t.run((ctx) => scoreAccount(ctx, survivor.accountId, 'new_fact', undefined, { now: NOW }));
    expect(alone.score).toMatchObject({ warmPoints: 0, trustSourceId: null });
    const both = await t.run((ctx) => scoreAccount(ctx, survivor.accountId, 'new_fact', undefined, { now: NOW, alsoAccountIds: [otherId] }));
    expect(both.score.warmPoints).toBeGreaterThan(0);
    expect(both.score).toMatchObject({ trustSourceId: agentId, warmIntroducerName: 'Ash' });
  });
});
