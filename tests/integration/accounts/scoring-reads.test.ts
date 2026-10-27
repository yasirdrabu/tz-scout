import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  archiveSignal,
  getAccountForScoring,
  getSummaries,
  listAccountIds,
  listPeople,
  upsertFromArrival,
  type ArrivalForAccounts,
} from '@/modules/accounts';
import { account, accountAlias, accountSummary, signal } from '@/modules/accounts/db/schema';
import { createOffer, createPractice } from '@/modules/offers';
import type { ModuleContext } from '@/platform/context';
import { adminDb, closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { completeOffer, freshTenant } from '../offers/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;

afterAll(closeDbs);

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId); // tenant defaults: buying roles, exclusion rules, vendor phrases
});

const domain = () => `${newId('acc').slice(-10).toLowerCase()}-example.com`;
const personAccess = { userId: 'usr_editor', sourceId: 'src_editor', dataLimit: { kind: 'all' as const } };

function arrival(over: Partial<ArrivalForAccounts> = {}): ArrivalForAccounts {
  return {
    arrivalId: newId('evt').replace('evt_', 'arr_'),
    receivedAt: new Date('2026-10-26T15:00:00Z'),
    sourceChain: { personSourceId: 'src_person1', agentSourceId: 'src_agent1' },
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

const seed = (over: Partial<ArrivalForAccounts> = {}) =>
  t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Scoring Reads Co', domain: domain() }, ...over })));

const eventsOf = async (accountId: string, type: string) =>
  (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = ${type}
        and payload->'data'->>'accountId' = ${accountId} order by seq`,
  )) as unknown as { payload: { data: Record<string, unknown> } }[];

describe('getAccountForScoring', () => {
  it('returns the survivor id and current columns for a merged id, and the exclusion label', async () => {
    const survivor = await seed({
      account: {
        name: 'Survivor Co',
        domain: domain(),
        industry: 'Logistics',
        industryKey: 'logistics',
        employees: 250,
        revenueCents: 5_000_000_00,
        hqCountry: 'US',
        technologies: ['sap', 'snowflake'],
        headcountGrowth6m: 0.12,
      },
    });
    const merged = await seed();
    await t.run(async (ctx) => {
      await ctx.tx.insert(accountAlias).values({ tenantId: ctx.tenantId, accountId: survivor.accountId, kind: 'merged_id', value: merged.accountId });
      await ctx.tx.update(account).set({ excludedReasonKey: 'competitor' }).where(eq(account.id, survivor.accountId));
    });
    const view = await t.run((ctx) => getAccountForScoring(ctx, merged.accountId));
    expect(view).toMatchObject({
      accountId: survivor.accountId,
      industry: 'Logistics',
      industryKey: 'logistics',
      employees: 250,
      revenueCents: 5_000_000_00,
      hqCountry: 'US',
      technologies: ['sap', 'snowflake'],
      headcountGrowth6m: 0.12,
      excludedReasonKey: 'competitor',
    });
    expect(view!.domain).toMatch(/-example\.com$/);
    expect(view!.excludedLabel).toEqual(expect.any(String));
    expect(view!.excludedLabel).not.toBe('');
    expect(await t.run((ctx) => getAccountForScoring(ctx, newId('acc')))).toBeNull();
  });
});

describe('listAccountIds', () => {
  it('pages 450 accounts (200, 200, 50) and filters by practice, no practice and signal age', async () => {
    const t2 = await freshTenant();
    const p1 = await t2.run((ctx) => createPractice(ctx, { name: 'List One', slug: 'list-one' }));
    const p2 = await t2.run((ctx) => createPractice(ctx, { name: 'List Two', slug: 'list-two' }));
    const ids = Array.from({ length: 450 }, () => newId('acc')).sort();
    await t2.run(async (ctx) => {
      await ctx.tx.insert(account).values(
        ids.map((id, i) => ({
          id,
          tenantId: ctx.tenantId,
          name: `Bulk ${i}`,
          matchName: `bulk ${i}`,
          practiceIds: i < 100 ? [p1.id] : i < 150 ? [p2.id] : [],
        })),
      );
      const day = 86_400_000;
      const sig = (accountId: string, occurredAt: Date | null, extra: Partial<typeof signal.$inferInsert> = {}) => ({
        id: newId('sig'),
        tenantId: ctx.tenantId,
        accountId,
        kind: 'trigger',
        title: 'A signal',
        occurredAt,
        ...extra,
      });
      await ctx.tx.insert(signal).values([
        sig(ids[0]!, new Date(Date.now() - 10 * day)),
        sig(ids[1]!, new Date(Date.now() - 400 * day)),
        sig(ids[2]!, new Date(Date.now() - 5 * day), { archivedAt: new Date() }),
        sig(ids[200]!, new Date(Date.now() - 20 * day)),
      ]);
    });
    const page = (opts: Parameters<typeof listAccountIds>[1]) => t2.run((ctx) => listAccountIds(ctx, opts));

    const first = await page({});
    const second = await page({ afterId: first.nextAfterId! });
    const third = await page({ afterId: second.nextAfterId! });
    expect([first.ids.length, second.ids.length, third.ids.length]).toEqual([200, 200, 50]);
    expect(first.nextAfterId).toBe(ids[199]);
    expect(third.nextAfterId).toBeNull();
    expect([...first.ids, ...second.ids, ...third.ids]).toEqual(ids);

    expect((await page({ practiceIds: [p1.id] })).ids).toEqual(ids.slice(0, 100));
    expect((await page({ practiceIds: [p1.id, p2.id] })).ids).toEqual(ids.slice(0, 150));
    const none = await page({ includeNoPractice: true }); // 300 match, so the first page is full
    expect(none.ids).toEqual(ids.slice(150, 350));
    expect((await page({ includeNoPractice: true, afterId: none.nextAfterId! })).ids).toEqual(ids.slice(350));
    expect((await page({ practiceIds: [p2.id], includeNoPractice: true })).ids).toEqual(ids.slice(100, 300));
    const since = new Date(Date.now() - 30 * 86_400_000);
    expect((await page({ hasSignalSince: since })).ids).toEqual([ids[0], ids[200]]);
    expect((await page({ hasSignalSince: since, practiceIds: [p1.id] })).ids).toEqual([ids[0]]);

    await t2.run((ctx) => ctx.tx.update(account).set({ archivedAt: new Date() }).where(eq(account.id, ids[0]!)));
    expect((await page({ practiceIds: [p1.id] })).ids).toEqual(ids.slice(1, 100));
  });

  it('refuses a context with an access and a page over 200', async () => {
    await expect(t.run((ctx) => listAccountIds({ ...ctx, access: personAccess }))).rejects.toMatchObject({ status: 403 });
    await expect(t.run((ctx) => listAccountIds(ctx, { limit: 201 }))).rejects.toMatchObject({ status: 400 });
  });
});

describe('getSummaries', () => {
  it('returns stage, review status, owner, priority, tier and best offer, limited to what the principal sees', async () => {
    const mine = await seed();
    const theirs = await seed();
    await t.run(async (ctx) => {
      await ctx.tx
        .update(accountSummary)
        .set({ stage: 'assigned', reviewStatusKey: 'reviewed', ownerUserId: 'usr_editor', priority: 72, tier: 'act_now', bestOfferId: 'off_x' })
        .where(eq(accountSummary.accountId, mine.accountId));
      await ctx.tx.update(accountSummary).set({ ownerUserId: 'usr_other' }).where(eq(accountSummary.accountId, theirs.accountId));
    });
    const ids = [mine.accountId, theirs.accountId, newId('acc')];
    const all = await t.run((ctx) => getSummaries(ctx, ids));
    expect(all.map((s) => s.accountId).sort()).toEqual([mine.accountId, theirs.accountId].sort());
    expect(all.find((s) => s.accountId === mine.accountId)).toEqual({
      accountId: mine.accountId,
      stage: 'assigned',
      reviewStatusKey: 'reviewed',
      ownerUserId: 'usr_editor',
      priority: 72,
      tier: 'act_now',
      bestOfferId: 'off_x',
    });
    const seller = await t.run((ctx) => getSummaries({ ...ctx, access: { userId: 'usr_editor', dataLimit: { kind: 'own_accounts' } } }, ids));
    expect(seller.map((s) => s.accountId)).toEqual([mine.accountId]);
    expect(await t.run((ctx) => getSummaries(ctx, []))).toEqual([]);
    await expect(t.run((ctx) => getSummaries(ctx, Array.from({ length: 1001 }, () => newId('acc'))))).rejects.toMatchObject({ status: 400 });
  });
});

describe('events', () => {
  it('an arrival fact, signal and account update carry arrivalId', async () => {
    const d = domain();
    await seed({ account: { name: 'Event Co', domain: d } });
    const first = await t.run((ctx) => ctx.tx.select({ id: account.id }).from(account).where(eq(account.domain, d)));
    const accountId = first[0]!.id;
    const a = arrival({
      account: { name: 'Event Co', domain: d, employees: 80 },
      signals: [{ kind: 'trigger', title: 'Raised a Series A', occurredAt: new Date('2026-10-01T00:00:00Z') }],
    });
    await t.run((ctx) => upsertFromArrival(ctx, a, accountId));
    expect((await eventsOf(accountId, 'accounts.fact.recorded')).at(-1)!.payload.data.arrivalId).toBe(a.arrivalId);
    expect((await eventsOf(accountId, 'accounts.signal.recorded')).at(-1)!.payload.data.arrivalId).toBe(a.arrivalId);
    const updated = (await eventsOf(accountId, 'accounts.account.updated')).at(-1)!.payload.data;
    expect(updated).toMatchObject({ arrivalId: a.arrivalId, changedKeys: ['employees'] });
  });

  it('archiveSignal publishes accounts.account.updated with changedKeys signals', async () => {
    const out = await seed({ signals: [{ kind: 'trigger', title: 'Hired a CIO', occurredAt: new Date('2026-10-01T00:00:00Z') }] });
    const [row] = await t.run((ctx) => ctx.tx.select({ id: signal.id }).from(signal).where(eq(signal.accountId, out.accountId)));
    const before = (await eventsOf(out.accountId, 'accounts.account.updated')).length;
    await t.run((ctx: ModuleContext) => archiveSignal({ ...ctx, access: personAccess }, row!.id, 'Not relevant'));
    const after = await eventsOf(out.accountId, 'accounts.account.updated');
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.payload.data).toEqual({ accountId: out.accountId, changedKeys: ['signals'] });
  });
});

describe('primary contact follows the best offer titles', () => {
  it('re-picks by the best offer target titles after a person is added', async () => {
    const p = await t.run((ctx) => createPractice(ctx, { name: 'Primary Practice', slug: 'primary-practice' }));
    const o = await t.run((ctx) => createOffer(ctx, { name: 'Primary Offer', practiceId: p.id, ...completeOffer, targetTitles: ['Head of Data'] }));
    const out = await seed({
      people: [
        { firstName: 'Cy', lastName: 'Chief', title: 'Chief Executive Officer', email: `cy@${domain()}` },
        { firstName: 'Dee', lastName: 'Data', title: 'Head of Data', email: `dee@${domain()}` },
      ],
    });
    const primaryName = async () => (await t.run((ctx) => listPeople(ctx, out.accountId))).find((x) => x.isPrimary)?.firstName;
    expect(await primaryName()).toBe('Cy');

    await t.run((ctx) => ctx.tx.update(accountSummary).set({ bestOfferId: o.id }).where(eq(accountSummary.accountId, out.accountId)));
    await t.run((ctx) =>
      upsertFromArrival(ctx, arrival({ people: [{ firstName: 'Eli', lastName: 'Extra', title: 'Analyst', email: `eli@${domain()}` }] }), out.accountId),
    );
    expect(await primaryName()).toBe('Dee');

    // An offer that is gone leaves the default rule in place.
    await t.run((ctx) => ctx.tx.update(accountSummary).set({ bestOfferId: 'off_gone' }).where(and(eq(accountSummary.accountId, out.accountId))));
    await t.run((ctx) =>
      upsertFromArrival(ctx, arrival({ people: [{ firstName: 'Fay', lastName: 'Extra', title: 'Analyst', email: `fay@${domain()}` }] }), out.accountId),
    );
    expect(await primaryName()).toBe('Cy');
  });
});
