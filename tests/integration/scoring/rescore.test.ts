import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// A test can name accounts whose scoring throws (or is refused with a 409); every other account scores as usual.
const failing = vi.hoisted(() => new Set<string>());
const refused = vi.hoisted(() => new Set<string>());
vi.mock('@/modules/scoring/services/score', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/scoring/services/score')>();
  const { ScoutError } = await import('@/platform/errors');
  return {
    ...real,
    scoreAccount: (...args: Parameters<typeof real.scoreAccount>) => {
      if (failing.has(args[1])) throw new Error('boom');
      if (refused.has(args[1])) throw new ScoutError({ slug: 'conflict', status: 409, title: 'Refused.' });
      return real.scoreAccount(...args);
    },
  };
});

import '@/entry/compose';
import { mergeAccounts, upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { account } from '@/modules/accounts/db/schema';
import { accountUpdated, signalRecorded } from '@/modules/accounts/contracts/events';
import { accountIdsForWarmIntroChange, confirmWarmIntro, getArrival, getWarmIntro, getWarmIntroSettings, intakeSourceInfo, registerSource, saveWarmIntroSettings, submitArrival } from '@/modules/intake';
import { arrivalRejected, arrivalResolved, sourceTrustChanged } from '@/modules/intake/contracts/events';
import { approveOffer, archiveOffer, createOffer, createPractice, listApprovedOffers } from '@/modules/offers';
import { offerChanged } from '@/modules/offers/contracts/events';
import { getScore, requestRescore, scoreAccount, setTierOverride, updateProfile } from '@/modules/scoring';
import { accountScore, offerMatch, rescoreRun, scoreChange } from '@/modules/scoring/db/schema';
import { ageingPage, rescoreAccounts } from '@/modules/scoring/services/rescore';
import { latestRescore } from '@/modules/scoring/services/rescore-runs';
import type { ModuleContext } from '@/platform/context';
import { adminDb, closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { completeOffer, freshTenant } from '../offers/helpers';
import { asPerson } from '../routing/helpers';

afterAll(closeDbs);
afterEach(() => {
  vi.restoreAllMocks();
  failing.clear();
  refused.clear();
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
const runOf = async (t: Tenant, id: string) => (await t.run((ctx) => ctx.tx.select().from(rescoreRun).where(eq(rescoreRun.id, id))))[0]!;
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

  it('an offer that left approved (unapprove) also gets the practice page, so a rescore in flight cannot keep it', async () => {
    const { t, practice } = await world();
    const o = await approved(t, practice.id, 'Unapproved');
    await runOutbox(t.tenantId);
    const pages = async () => (await outboxOf(t, 'jobs.scoring.rescore.page')).length;
    await t.run((ctx) => ctx.tx.execute(sql`update offers.offer set status = 'draft' where id = ${o.id}`));
    const before = await pages();
    await publishTestEvent(t.tenantId, offerChanged, { offerId: o.id, practiceId: practice.id, changed: ['status'], affectsMatching: true });
    await runOutbox(t.tenantId);
    expect(await pages()).toBe(before + 2);
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
    expect((await current(t, accA))!.trustScore).toBe(60);
    vi.spyOn(intakeSourceInfo, 'getTrust').mockResolvedValue(0.9);
    await publishTestEvent(t.tenantId, sourceTrustChanged, { sourceId: agentA, level: 'agent', from: 0.6, to: 0.9, sampleSize: 20, cause: 'outcomes' });
    await runOutbox(t.tenantId);
    expect((await current(t, accA))!.trustScore).toBe(90);
    expect((await current(t, accA))!.trustModifier).toBe(0);
    expect((await current(t, accB))!.trustScore).toBe(60);
    expect((await changes(t, accA)).some((c) => c.cause === 'trust_changed')).toBe(true);
  });

  it('SCO-E3-S1-AC4: a cutoff change moves tiers after the jobs run', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    const a = await seed(t);
    await score(t, a.accountId);
    expect((await current(t, a.accountId))!.tier).not.toBe('not_fit');
    await t.run((ctx) => updateProfile(ctx, { tierCutoffs: { actNow: 100, goodFit: 99, watch: 98 } }));
    await runOutbox(t.tenantId);
    expect(await current(t, a.accountId)).toMatchObject({ tier: 'nurture', scoredTier: 'nurture', profileVersion: 2 });
    expect((await changes(t, a.accountId)).map((c) => c.cause)).toContain('rules_changed');
  });
});

describe('hand-set tiers (Review Focus 1)', () => {
  it.each(['nurture', 'act_now'] as const)('a hand-set %s tier survives a rules_changed rescore', async (tier) => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    const a = await seed(t);
    await score(t, a.accountId);
    await asPerson(t, (ctx) => setTierOverride(ctx, a.accountId, { tier }));
    await t.run((ctx) => updateProfile(ctx, { tierCutoffs: { actNow: 100, goodFit: 99, watch: 98 } }));
    await runOutbox(t.tenantId);
    expect(await current(t, a.accountId)).toMatchObject({ tier, tierOverride: tier, scoredTier: 'nurture', profileVersion: 2 });
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
    const { runId } = await t.run((ctx) => requestRescore(ctx, { practiceId: practice.id }));
    expect(await runOf(t, runId)).toMatchObject({ cause: 'manual_rescore', filter: { practiceId: practice.id }, total: 0, done: 0, pagingDone: false, finishedAt: null });
    await runOutbox(t.tenantId);
    const jobs = await outboxOf(t, 'jobs.scoring.rescore.accounts');
    expect(jobs.map((j) => (j.data.accountIds as string[]).length)).toEqual([200, 200, 50]);
    expect(jobs.every((j) => j.data.runId === runId)).toBe(true);
    expect(await t.run((ctx) => ctx.tx.select().from(accountScore))).toHaveLength(450);
    const done = await runOf(t, runId);
    expect(done).toMatchObject({ total: 450, done: 450, pagingDone: true, finishedAt: expect.any(Date) });

    // Review Focus 5: an accounts message delivered again counts nothing more.
    await t.run((ctx) => rescoreAccounts(ctx, jobs[2]!.data.accountIds as string[], 'manual_rescore', runId));
    expect(await runOf(t, runId)).toMatchObject({ total: 450, done: 450, finishedAt: done.finishedAt });
    expect(await t.run((ctx) => latestRescore(ctx))).toEqual({
      id: runId,
      cause: 'manual_rescore',
      total: 450,
      done: 450,
      startedAt: done.startedAt,
      finishedAt: done.finishedAt,
      stalled: false,
    });
  }, 120_000);
});

describe('rescore runs (Ruling 12)', () => {
  it('Review Focus 5: the last message fails and retries; done never passes total and finished_at is set once', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    const [one, bad, three] = [await seed(t, [practice.id]), await seed(t, [practice.id]), await seed(t, [practice.id])];
    await runOutbox(t.tenantId);
    failing.add(bad.accountId);
    const { runId } = await t.run((ctx) => requestRescore(ctx, { practiceId: practice.id }));
    // The page message, then the accounts message (two scored, the bad one queued alone), then that one fails.
    await expect(runOutbox(t.tenantId)).rejects.toThrow('boom');
    expect(await runOf(t, runId)).toMatchObject({ total: 3, done: 2, pagingDone: true, finishedAt: null });
    failing.clear();
    await runOutbox(t.tenantId);
    const finished = await runOf(t, runId);
    expect(finished).toMatchObject({ total: 3, done: 3, finishedAt: expect.any(Date) });
    // The single-account message delivered again, and the first message again: still 3, finished at the same time.
    await t.run((ctx) => rescoreAccounts(ctx, [bad.accountId], 'manual_rescore', runId));
    await t.run((ctx) => rescoreAccounts(ctx, [one.accountId, bad.accountId, three.accountId], 'manual_rescore', runId));
    expect(await runOf(t, runId)).toMatchObject({ total: 3, done: 3, finishedAt: finished.finishedAt });
  });

  it('a lone account refused with a 4xx is settled, not retried, so the run finishes', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    const [, bad] = [await seed(t, [practice.id]), await seed(t, [practice.id]), await seed(t, [practice.id])];
    await runOutbox(t.tenantId);
    refused.add(bad.accountId);
    const { runId } = await t.run((ctx) => requestRescore(ctx, { practiceId: practice.id }));
    await runOutbox(t.tenantId);
    expect(await current(t, bad.accountId)).toBeUndefined();
    const run = await runOf(t, runId);
    expect(run).toMatchObject({ total: 3, done: 3, finishedAt: expect.any(Date) });
    expect(run.updatedAt.getTime()).toBeGreaterThan(run.startedAt.getTime());
  });

  it('a run with every page listed that counts nothing for 15 minutes is stalled', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    const bad = await seed(t, [practice.id]);
    await runOutbox(t.tenantId);
    failing.add(bad.accountId);
    const { runId } = await t.run((ctx) => requestRescore(ctx, { practiceId: practice.id }));
    await expect(runOutbox(t.tenantId)).rejects.toThrow('boom');
    const { updatedAt } = await runOf(t, runId);
    const at = (minutes: number) => new Date(updatedAt.getTime() + minutes * 60_000);
    expect(await t.run((ctx) => latestRescore(ctx, at(14)))).toMatchObject({ id: runId, finishedAt: null, stalled: false });
    expect(await t.run((ctx) => latestRescore(ctx, at(16)))).toMatchObject({ id: runId, finishedAt: null, stalled: true });
    // Still paging: not stalled, however long since the last count.
    await t.run((ctx) => ctx.tx.update(rescoreRun).set({ pagingDone: false }).where(eq(rescoreRun.id, runId)));
    expect(await t.run((ctx) => latestRescore(ctx, at(16)))).toMatchObject({ stalled: false });
  });

  it('an empty filter finishes at once with nothing to do; a message without a run id still scores', async () => {
    const { t, practice } = await world();
    const { runId } = await t.run((ctx) => requestRescore(ctx, { practiceId: practice.id }));
    await runOutbox(t.tenantId);
    expect(await runOf(t, runId)).toMatchObject({ total: 0, done: 0, pagingDone: true, finishedAt: expect.any(Date) });
    const a = await seed(t);
    await runOutbox(t.tenantId);
    await t.run((ctx) => rescoreAccounts(ctx, [a.accountId], 'manual_rescore'));
    expect(await current(t, a.accountId)).toBeDefined();
  });

  it('a tenant-wide trigger records a run; latest is the newest run of the last 24 hours, of this tenant only', async () => {
    const { t } = await world();
    const other = await world();
    expect(await t.run((ctx) => latestRescore(ctx))).toBeNull();
    await t.run((ctx) => updateProfile(ctx, { weights: { fit: 50, intent: 30, revenue: 10, trust: 10 } }));
    await runOutbox(t.tenantId);
    const latest = await t.run((ctx) => latestRescore(ctx));
    expect(latest).toMatchObject({ id: expect.stringMatching(/^rsr_/), cause: 'rules_changed', finishedAt: expect.any(Date) });
    expect(await other.t.run((ctx) => latestRescore(ctx))).toBeNull();
    expect(await t.run((ctx) => latestRescore(ctx, new Date(Date.now() + 25 * 3_600_000)))).toBeNull();
  });
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

describe('fan-out on warm intros', () => {
  async function warmWorld() {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    await runOutbox(t.tenantId);
    const agentId = await t.run(async (ctx) => {
      const person = await registerSource(ctx, { kind: 'person', name: 'Ash' });
      return (await registerSource(ctx, { kind: 'agent', name: 'Ash agent', parentId: person.id })).id;
    });
    /** An account with an agent-declared (unconfirmed) intro: employee_network is 8, so 4 until confirmed. */
    const intro = async (key = 'employee_network') => {
      const sent = await t.run((ctx) =>
        submitArrival(
          { ...ctx, access: { sourceId: agentId, dataLimit: { kind: 'own_source' } } },
          { account: { name: 'Warm Co', domain: domain(), industry: 'Logistics' }, warm_intro: { introducer_name: 'Ash', relationship_key: key } },
          { channel: 'api' },
        ),
      );
      await runOutbox(t.tenantId);
      const accountId = (await t.run((ctx) => getArrival(ctx, sent.arrivalId)))!.accountId!;
      const view = (await t.run((ctx) => getWarmIntro(ctx, accountId)))!;
      return { accountId, warmIntroId: view.warmIntroId };
    };
    return { t, intro };
  }
  const reprice = async (t: Tenant, points: number) => {
    const s = await t.run((ctx) => getWarmIntroSettings(ctx));
    return t.run((ctx) =>
      saveWarmIntroSettings(ctx, {
        relationships: s.relationships.map((r) => ({ key: r.key, points: r.key === 'employee_network' ? points : r.points })),
        rules: [],
      }),
    );
  };

  it('confirming an intro rescores its account: warm points go from 4 to 8 and the run finishes 1/1', async () => {
    const { t, intro } = await warmWorld();
    const { accountId, warmIntroId } = await intro();
    expect((await current(t, accountId))!.warmPoints).toBe(4);
    await t.run((ctx) => confirmWarmIntro(ctx, warmIntroId, { canReview: true }));
    await runOutbox(t.tenantId);
    expect((await current(t, accountId))!.warmPoints).toBe(8);
    expect((await changes(t, accountId)).some((c) => c.cause === 'warm_intro')).toBe(true);
    const run = (await t.run((ctx) => ctx.tx.select().from(rescoreRun).where(eq(rescoreRun.cause, 'warm_intro'))))[0]!;
    expect(run).toMatchObject({ total: 1, done: 1 });
    expect(run.finishedAt).not.toBeNull();
  });

  it('a default change rescores only the stamped accounts: the run total is rescoringAccountCount', async () => {
    const { t, intro } = await warmWorld();
    const a = await intro('employee_network');
    const b = await intro('employee_network');
    const c = await intro('event_meeting');
    const before = await current(t, c.accountId);
    const out = await reprice(t, 12);
    expect(out.rescoringAccountCount).toBe(2);
    await runOutbox(t.tenantId);
    const run = (await t.run((ctx) => ctx.tx.select().from(rescoreRun).where(eq(rescoreRun.cause, 'warm_intro'))))[0]!;
    expect(run).toMatchObject({ total: 2, done: 2 });
    expect((await current(t, a.accountId))!.warmPoints).toBe(6);
    expect((await current(t, b.accountId))!.warmPoints).toBe(6);
    expect((await current(t, c.accountId))!.computedAt).toEqual(before!.computedAt);
  });

  it('Review Focus 5: a reprice after a merge rescores the survivor, and the merged-away account is not listed', async () => {
    const { t, intro } = await warmWorld();
    const merged = await intro('employee_network');
    const survivor = await seed(t);
    await score(t, survivor.accountId);
    const person = { userId: 'usr_leader', sourceId: 'src_leader', dataLimit: { kind: 'all' as const } };
    await t.run((ctx) => mergeAccounts({ ...ctx, access: person } as ModuleContext, survivor.accountId, merged.accountId));
    await runOutbox(t.tenantId);
    const out = await reprice(t, 12);
    expect(out.rescoringAccountCount).toBe(1);
    const { changeId } = (await outboxOf(t, 'intake.warm_intro.repriced'))[0]!.data as { changeId: string };
    expect(await t.run((ctx) => accountIdsForWarmIntroChange(ctx, changeId, { limit: 50 }))).toEqual([survivor.accountId]);
    await runOutbox(t.tenantId);
    expect((await current(t, survivor.accountId))!.warmPoints).toBe(6);
    expect(await current(t, merged.accountId)).toBeUndefined();
  });

  it('a stamped intro still on a merged-away account rescores the survivor, not nothing', async () => {
    const { t, intro } = await warmWorld();
    const merged = await intro('employee_network');
    const survivor = await seed(t);
    await score(t, survivor.accountId);
    const person = { userId: 'usr_leader', sourceId: 'src_leader', dataLimit: { kind: 'all' as const } };
    await t.run((ctx) => mergeAccounts({ ...ctx, access: person } as ModuleContext, survivor.accountId, merged.accountId));
    await runOutbox(t.tenantId);
    // The merge window: the intro has not moved to the survivor yet when the save stamps it.
    await adminDb.execute(sql`update intake.warm_intro set account_id = ${merged.accountId} where id = ${merged.warmIntroId}`);
    const out = await reprice(t, 12);
    expect(out.rescoringAccountCount).toBe(1);
    const { changeId } = (await outboxOf(t, 'intake.warm_intro.repriced'))[0]!.data as { changeId: string };
    expect(await t.run((ctx) => accountIdsForWarmIntroChange(ctx, changeId, { limit: 50 }))).toEqual([merged.accountId]);
    await runOutbox(t.tenantId);
    const run = (await t.run((ctx) => ctx.tx.select().from(rescoreRun).where(eq(rescoreRun.cause, 'warm_intro'))))[0]!;
    expect(run).toMatchObject({ total: 1, done: 1 });
    expect(run.finishedAt).not.toBeNull();
  });
});
