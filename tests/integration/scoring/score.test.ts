import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import '@/entry/compose';
import { upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { account } from '@/modules/accounts/db/schema';
import { getArrival, intakeSourceInfo, registerSource, submitArrival } from '@/modules/intake';
import { approveOffer, archiveOffer, createOffer, createPractice, replaceSignalRules } from '@/modules/offers';
import { getMatches, getScore, getScoreHistory, scoreAccount } from '@/modules/scoring';
import { accountScore, offerMatch, scoreChange } from '@/modules/scoring/db/schema';
import type { ModuleContext } from '@/platform/context';
import { adminDb, closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { completeOffer, freshTenant } from '../offers/helpers';

afterAll(closeDbs);
afterEach(() => vi.restoreAllMocks());

type Tenant = Awaited<ReturnType<typeof freshTenant>>;
const NOW = new Date('2026-10-27T12:00:00Z');
const domain = () => `${newId('acc').slice(-10).toLowerCase()}-example.com`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

/** A tenant with its defaults and one practice. */
async function world() {
  const t = await freshTenant();
  await runOutbox(t.tenantId);
  const practice = await t.run((ctx) => createPractice(ctx, { name: 'Score Practice', slug: slug('p') }));
  return { t, practice };
}

async function approved(t: Tenant, practiceId: string, name: string) {
  const o = await t.run((ctx) => createOffer(ctx, { name, practiceId, ...completeOffer }));
  await t.run((ctx) => approveOffer(ctx, o.id));
  return o;
}

const seed = (t: Tenant, over: Partial<ArrivalForAccounts['account']> = {}, rest: Partial<ArrivalForAccounts> = {}) =>
  t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Score Co', domain: domain(), industry: 'Logistics', ...over }, ...rest })));

const score = (t: Tenant, id: string, cause: Parameters<typeof scoreAccount>[2] = 'manual_rescore', causeEventId?: string) =>
  t.run((ctx) => scoreAccount(ctx, id, cause, causeEventId, { now: NOW }));

const scoredEvents = async (t: Tenant, accountId: string) =>
  (
    (await adminDb.execute(
      sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = 'scoring.account.scored'
          and payload->'data'->>'accountId' = ${accountId} order by seq`,
    )) as unknown as { payload: { data: Record<string, unknown> } }[]
  ).map((r) => r.payload.data);
const changes = (t: Tenant, accountId: string) =>
  t.run((ctx) => ctx.tx.select().from(scoreChange).where(and(eq(scoreChange.tenantId, ctx.tenantId), eq(scoreChange.accountId, accountId))));
const matchRows = (t: Tenant, accountId: string) => t.run((ctx) => ctx.tx.select().from(offerMatch).where(eq(offerMatch.accountId, accountId)));

describe('scoreAccount offers (SCO-E1-S1)', () => {
  it('AC1: one offer_match per approved offer in the account practices, with five fit parts each', async () => {
    const { t, practice } = await world();
    const other = await t.run((ctx) => createPractice(ctx, { name: 'Other Practice', slug: slug('o') }));
    await approved(t, practice.id, 'One');
    await approved(t, practice.id, 'Two');
    await approved(t, practice.id, 'Three');
    await approved(t, other.id, 'Elsewhere');
    const a = await seed(t);
    await t.run((ctx) => ctx.tx.update(account).set({ practiceIds: [practice.id] }).where(eq(account.id, a.accountId)));
    await score(t, a.accountId);
    const rows = await matchRows(t, a.accountId);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.fitParts as unknown[]).toHaveLength(5);
  });

  it('AC2 and AC3: no practice means every approved offer, and draft and archived offers are never scored', async () => {
    const { t, practice } = await world();
    const other = await t.run((ctx) => createPractice(ctx, { name: 'Other Practice', slug: slug('o') }));
    const keep = await approved(t, practice.id, 'Kept');
    const elsewhere = await approved(t, other.id, 'Elsewhere');
    const gone = await approved(t, practice.id, 'Gone');
    await t.run((ctx) => archiveOffer(ctx, gone.id));
    await t.run((ctx) => createOffer(ctx, { name: 'Draft', practiceId: practice.id, ...completeOffer }));
    const a = await seed(t);
    await score(t, a.accountId);
    expect((await matchRows(t, a.accountId)).map((r) => r.offerId).sort()).toEqual([keep.id, elsewhere.id].sort());
  });
});

describe('scoreAccount results', () => {
  it('first score stores version 1, writes a score_change and publishes with previousTier null', async () => {
    const { t, practice } = await world();
    const o = await approved(t, practice.id, 'Lead');
    const a = await seed(t);
    const r = await score(t, a.accountId, 'new_fact', 'evt_cause1');
    expect(r.changed).toBe(true);
    expect(r.score).toMatchObject({ accountId: a.accountId, version: 1, bestOfferId: o.id });
    const [change] = await changes(t, a.accountId);
    expect(change).toMatchObject({ fromPriority: null, fromTier: null, fromOfferId: null, toOfferId: o.id, cause: 'new_fact', causeEventId: 'evt_cause1' });
    const events = await scoredEvents(t, a.accountId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ previousTier: null, previousBestOfferId: null, version: 1, bestOfferId: o.id, practiceId: practice.id, cause: 'new_fact' });
  });

  it('SCO-E5-S1-AC2: an unchanged rescore on the same day writes and publishes nothing', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    const a = await seed(t);
    const first = await score(t, a.accountId);
    const again = await score(t, a.accountId, 'new_signal');
    expect(again.changed).toBe(false);
    expect(again.score.version).toBe(first.score.version);
    expect(await scoredEvents(t, a.accountId)).toHaveLength(1);
    expect(await changes(t, a.accountId)).toHaveLength(1);
  });

  it('a changed input bumps the version; a move in priority writes one score_change and one event', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    const a = await seed(t, { industry: undefined });
    const first = await score(t, a.accountId);
    await t.run((ctx) => ctx.tx.update(account).set({ industry: 'Logistics' }).where(eq(account.id, a.accountId)));
    const second = await score(t, a.accountId, 'new_fact');
    expect(second.changed).toBe(true);
    expect(second.score.version).toBe(2);
    expect(second.score.priority).toBeGreaterThan(first.score.priority);
    expect(await changes(t, a.accountId)).toHaveLength(2);
    const events = await scoredEvents(t, a.accountId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ previousTier: first.score.tier, version: 2 });
  });

  it('with no approved offers: no best offer, not_fit, priority 0 and the line says why', async () => {
    const { t } = await world();
    const a = await seed(t);
    const r = await score(t, a.accountId);
    expect(r.score).toMatchObject({ bestOfferId: null, tier: 'not_fit', priority: 0, fit: 0, intent: 0 });
    const lines = (r.score.explanation as { lines: { text?: string }[] }).lines;
    expect(lines.map((l) => l.text)).toContain('No approved offer to match against.');
    expect(await matchRows(t, a.accountId)).toHaveLength(0);
    expect(await scoredEvents(t, a.accountId)).toHaveLength(1);
  });

  it('an excluded account is disqualified for every offer with the exclusion label', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'One');
    await approved(t, practice.id, 'Two');
    const a = await seed(t);
    await t.run((ctx) => ctx.tx.update(account).set({ excludedReasonKey: 'competitor' }).where(eq(account.id, a.accountId)));
    const r = await score(t, a.accountId);
    expect(r.score).toMatchObject({ tier: 'not_fit', priority: 0 });
    const rows = await t.run((ctx) => getMatches(ctx, a.accountId));
    expect(rows).toHaveLength(2);
    const label = rows[0]!.disqualifiedReason;
    expect(label).toEqual(expect.any(String));
    for (const m of rows) expect(m).toMatchObject({ disqualifiedReason: label, fit: 0, tier: 'not_fit' });
  });

  it('a merged id scores the survivor', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    const survivor = await seed(t);
    const merged = await seed(t);
    await t.run((ctx) =>
      ctx.tx.execute(
        sql`insert into accounts.account_alias (tenant_id, account_id, kind, value) values (${ctx.tenantId}, ${survivor.accountId}, 'merged_id', ${merged.accountId})`,
      ),
    );
    const r = await score(t, merged.accountId);
    expect(r.score.accountId).toBe(survivor.accountId);
    expect(await t.run((ctx) => ctx.tx.select().from(accountScore).where(eq(accountScore.accountId, merged.accountId)))).toHaveLength(0);
  });

  it('uses preloaded offers when given', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    const a = await seed(t);
    const r = await t.run((ctx) => scoreAccount(ctx, a.accountId, 'manual_rescore', undefined, { now: NOW, offers: [] }));
    expect(r.score.bestOfferId).toBeNull();
  });
});

describe('explanation lines', () => {
  it('SCO-E2-S2-AC3 and SCO-E2-S3-AC2: names the introducer and the source', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    const agentId = await t.run(async (ctx) => {
      const person = await registerSource(ctx, { kind: 'person', name: 'Ash' });
      const agent = await registerSource(ctx, { kind: 'agent', name: "Ash's research agent", parentId: person.id });
      return agent.id;
    });
    vi.spyOn(intakeSourceInfo, 'getTrust').mockResolvedValue(0.72);
    const sent = await t.run((ctx) =>
      submitArrival(
        { ...ctx, access: { sourceId: agentId, dataLimit: { kind: 'own_source' } } },
        { account: { name: 'Warm Co', domain: domain(), industry: 'Logistics' }, warm_intro: { introducer_name: 'Ash', relationship_key: 'event_meeting' } },
        { channel: 'api', canDeclareWarmIntro: true },
      ),
    );
    await runOutbox(t.tenantId);
    const accountId = (await t.run((ctx) => getArrival(ctx, sent.arrivalId)))!.accountId!;
    const r = await score(t, accountId);
    const lines = (r.score.explanation as { lines: { group: string; label: string; points?: number }[] }).lines.filter((l) => l.group === 'adjust');
    expect(lines.map((l) => l.label)).toEqual(['Warm intro from Ash', "Source trust 0.72 (Ash's research agent)"]);
    expect(lines[0]!.points).toBeGreaterThan(0);
    expect(lines[1]!.points).toBe(3);
    expect(r.score).toMatchObject({ trustModifier: 3, trustSourceId: agentId, warmIntroducerName: 'Ash' });
  });

  it('a dated signal that matches an offer rule produces an intent line', async () => {
    const { t, practice } = await world();
    const o = await approved(t, practice.id, 'Lead');
    await t.run((ctx) =>
      replaceSignalRules(ctx, o.id, [{ type: 'funding', label: 'Fresh funding', weight: 40, match: [], minValue: null, why: 'Money to spend.', enabled: true }]),
    );
    const a = await seed(t, {}, { signals: [{ kind: 'trigger', type: 'funding', title: 'Series B', occurredAt: new Date('2026-10-20T00:00:00Z') }] });
    const r = await score(t, a.accountId);
    const lines = (r.score.explanation as { lines: { group: string; label: string }[] }).lines;
    expect(lines.filter((l) => l.group === 'intent').map((l) => l.label)).toEqual(['Fresh funding']);
    expect(r.score.intent).toBeGreaterThan(0);
  });
});

describe('concurrent rescoring (Review Focus 1)', () => {
  it('three rescores of one account at once give one score and one score_change', async () => {
    const { t, practice } = await world();
    await approved(t, practice.id, 'Lead');
    const a = await seed(t);
    // The first transaction holds its lock and its uncommitted write while the other two start.
    const first = t.run(async (ctx) => {
      const r = await scoreAccount(ctx, a.accountId, 'new_signal', undefined, { now: NOW });
      await sleep(400);
      return r;
    });
    await sleep(150);
    const others = Promise.all([score(t, a.accountId, 'trust_changed'), score(t, a.accountId, 'rules_changed')]);
    const results = [await first, ...(await others)];
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.score.version))).toEqual(new Set([1]));
    expect(await changes(t, a.accountId)).toHaveLength(1);
    expect(await scoredEvents(t, a.accountId)).toHaveLength(1);
    expect(await t.run((ctx) => ctx.tx.select().from(accountScore).where(eq(accountScore.accountId, a.accountId)))).toHaveLength(1);
    expect(await matchRows(t, a.accountId)).toHaveLength(1);
  });
});

describe('reads', () => {
  it('returns the score, the matches and the history, and a hidden account is null', async () => {
    const { t, practice } = await world();
    const o = await approved(t, practice.id, 'Lead');
    const a = await seed(t);
    await score(t, a.accountId);
    expect(await t.run((ctx) => getScore(ctx, a.accountId))).toMatchObject({ accountId: a.accountId, version: 1 });
    expect(await t.run((ctx) => getScore(ctx, a.accountId, { offerId: o.id }))).toMatchObject({ match: { offerId: o.id } });
    expect((await t.run((ctx) => getMatches(ctx, a.accountId))).map((m) => m.offerId)).toEqual([o.id]);
    expect(await t.run((ctx) => getScoreHistory(ctx, a.accountId, { limit: 10 }))).toHaveLength(1);
    await expect(t.run((ctx) => getScoreHistory(ctx, a.accountId, { limit: 51 }))).rejects.toMatchObject({ status: 400 });

    const limited = (ctx: ModuleContext): ModuleContext => ({ ...ctx, access: { sourceId: 'src_nobody', dataLimit: { kind: 'own_source' } } });
    expect(await t.run((ctx) => getScore(limited(ctx), a.accountId))).toBeNull();
    expect(await t.run((ctx) => getMatches(limited(ctx), a.accountId))).toEqual([]);
    expect(await t.run((ctx) => getScoreHistory(limited(ctx), a.accountId, { limit: 10 }))).toEqual([]);
  });
});
