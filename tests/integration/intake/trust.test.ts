// R3b-2 Task 2: the nightly trust job, its history, the conflict-loss drop and `intake.source.trust_changed`.
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listConflicts, mergeAccounts, resolveConflict } from '@/modules/accounts';
import { computeTrust, getArrivalWithStatus, recordFeedback, registerSource, seedIntakeDefaults, submitArrival } from '@/modules/intake';
import { arrival, source, sourceTrustHistory } from '@/modules/intake/db/schema';
import { TRUST_PRIOR, trustOf } from '@/modules/intake/domain/trust';
import { pipelineStage, stageChange } from '@/modules/routing/db/schema';
import type { ModuleContext } from '@/platform/context';
import { closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, freshTenant, personAndAgent, validArrival, type Tenant } from './helpers';

let t: Tenant;
let vendorId: string;
let seq = 0;

afterAll(closeDbs);
beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
  vendorId = await t.run(async (ctx) => (await registerSource(ctx, { kind: 'vendor', name: 'Trust Vendor' })).id);
});

const NOW = () => new Date();
const asPerson = <T>(fn: (ctx: ModuleContext) => Promise<T>) => t.run((ctx) => fn({ ...ctx, access: { userId: 'usr_leader', dataLimit: { kind: 'all' } } }));
const agent = () => personAndAgent(t, `Trust ${Date.now().toString(36)}${++seq}`);

/** Sends one arrival (a new account, or `domain`'s) and returns its arrival and account, resolved `resolvedAgoMs` ago. */
async function send(sourceId: string, resolvedAgoMs: number, now: Date, domain?: string) {
  const body = domain ? { account: { name: `Trust ${domain}`, domain } } : validArrival();
  const a = await asSource(t, sourceId, (ctx) => submitArrival(ctx, body, { channel: 'api' }));
  await runOutbox(t.tenantId);
  const accountId = (await asSource(t, sourceId, (ctx) => getArrivalWithStatus(ctx, a.arrivalId, { ownerName: false })))!.accountId!;
  await t.run((ctx) => ctx.tx.update(arrival).set({ resolvedAt: new Date(now.getTime() - resolvedAgoMs) }).where(eq(arrival.id, a.arrivalId)));
  return { arrivalId: a.arrivalId, accountId };
}

const enter = (accountId: string, toStage: string, at: Date) =>
  t.run((ctx) => ctx.tx.insert(stageChange).values({ id: newId('stc'), tenantId: ctx.tenantId, accountId, fromStage: 'arrived', toStage, causeEventId: newId('evt'), at }));

const row = (sourceId: string) => t.run(async (ctx) => (await ctx.tx.select().from(source).where(eq(source.id, sourceId)))[0]!);
const history = (sourceId: string) =>
  t.run((ctx) => ctx.tx.select().from(sourceTrustHistory).where(and(eq(sourceTrustHistory.sourceId, sourceId))).orderBy(sourceTrustHistory.computedAt));
const trustEvents = (sourceId: string) =>
  t.run(async (ctx) =>
    (await ctx.tx.select().from(outbox).where(eq(outbox.tenantId, ctx.tenantId)).orderBy(outbox.seq))
      .map((r) => r.payload as { type: string; data: Record<string, unknown> })
      .filter((p) => p.type === 'intake.source.trust_changed' && p.data.sourceId === sourceId)
      .map((p) => p.data),
  );
const compute = (sourceIds: string[], now: Date) => t.run((ctx) => computeTrust(ctx, { cause: 'outcomes', sourceIds, now }));

describe('computeTrust', () => {
  it('a source with no arrivals stays at 0.60, writes a history row with sample 0 and publishes nothing', async () => {
    const lone = await t.run(async (ctx) => (await registerSource(ctx, { kind: 'vendor', name: `Lone ${Date.now()}` })).id);
    const res = await compute([lone], NOW());
    expect(res).toEqual([{ sourceId: lone, from: TRUST_PRIOR, to: TRUST_PRIOR, sampleSize: 0, published: false }]);
    expect(await row(lone)).toMatchObject({ trust: 0.6, trustSample: 0, trustWon: 0, trustPublished: 0.6 });
    const h = await history(lone);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ trust: 0.6, sampleSize: 0, won: 0, inputs: { cause: 'outcomes', conflictsLost: 0, level: 'vendor' } });
    expect(await trustEvents(lone)).toEqual([]);
  });

  it('an agent whose 12 accounts were all won: agent and owner trust rise, one event, a second run adds a history row but no event', async () => {
    const a = await agent();
    const now = NOW();
    for (let i = 0; i < 12; i++) {
      const s = await send(a.agentId, 60_000, now);
      await enter(s.accountId, 'won', new Date(now.getTime() - 30_000));
    }
    const expected = trustOf(Array.from({ length: 12 }, () => ({ quality: 1, ageDays: 60_000 / 86_400_000 })), 0);
    expect(expected).toBeCloseTo(0.8182, 3);

    await compute([a.agentId, a.personId], now);
    for (const id of [a.agentId, a.personId]) {
      expect(await row(id)).toMatchObject({ trust: expected, trustPublished: expected, trustSample: 12, trustWon: 12 });
      expect(await row(id)).not.toMatchObject({ trustUpdatedAt: null });
    }
    expect(await trustEvents(a.agentId)).toEqual([{ sourceId: a.agentId, level: 'agent', from: 0.6, to: expected, sampleSize: 12, cause: 'outcomes' }]);
    expect(await trustEvents(a.personId)).toMatchObject([{ level: 'person', from: 0.6, to: expected }]);

    // Review Focus 4: nothing new, so one more history row and no second event.
    await compute([a.agentId, a.personId], new Date(now.getTime() + 1000));
    expect(await history(a.agentId)).toHaveLength(2);
    expect(await trustEvents(a.agentId)).toHaveLength(1);
    expect((await row(a.agentId)).trust).toBe(expected);
  });

  it('the same agent sending the same account twice earns one credit (Review Focus 3)', async () => {
    const a = await agent();
    const now = NOW();
    const domain = `twice${Date.now().toString(36)}${++seq}-example.com`;
    const first = await send(a.agentId, 120_000, now, domain);
    const second = await send(a.agentId, 60_000, now, domain);
    expect(second.accountId).toBe(first.accountId);
    await enter(first.accountId, 'won', new Date(now.getTime() - 30_000));
    await compute([a.agentId], now);
    expect(await row(a.agentId)).toMatchObject({ trustSample: 1, trustWon: 1 });
  });

  it('an arrival resolved after the account entered assigned is not counted', async () => {
    const a = await agent();
    const now = NOW();
    const late = await send(a.agentId, 60_000, now);
    await enter(late.accountId, 'assigned', new Date(now.getTime() - 86_400_000));
    const early = await send(a.agentId, 60_000, now);
    await enter(early.accountId, 'assigned', new Date(now.getTime() - 30_000));
    await compute([a.agentId], now);
    expect(await row(a.agentId)).toMatchObject({ trustSample: 1 });
  });

  it('a seller decline for a bad fit scores 0 unless later progress; other reasons keep the stage quality', async () => {
    const now = NOW();
    const bad = await agent();
    const s1 = await send(bad.agentId, 3_600_000, now);
    await enter(s1.accountId, 'reviewed', new Date(now.getTime() - 3_000_000));
    await t.run((ctx) => recordFeedback(ctx, { accountId: s1.accountId, kind: 'declined_by_seller', reasonKey: 'not_a_fit', note: null, causeEventId: newId('evt') }));
    await compute([bad.agentId], new Date(now.getTime() + 60_000));
    expect(await row(bad.agentId)).toMatchObject({ trustSample: 1, trust: trustOf([{ quality: 0, ageDays: 3_660_000 / 86_400_000 }], 0) });

    const busy = await agent();
    const s2 = await send(busy.agentId, 3_600_000, now);
    await enter(s2.accountId, 'reviewed', new Date(now.getTime() - 3_000_000));
    await t.run((ctx) => recordFeedback(ctx, { accountId: s2.accountId, kind: 'declined_by_seller', reasonKey: 'too_much_on_my_plate', note: null, causeEventId: newId('evt') }));
    await compute([busy.agentId], new Date(now.getTime() + 60_000));
    expect(await row(busy.agentId)).toMatchObject({ trustSample: 1, trust: trustOf([{ quality: 0.3, ageDays: 3_660_000 / 86_400_000 }], 0) });
  });

  it('an entry into an archived flow stage still counts at its quality', async () => {
    const a = await agent();
    const now = NOW();
    const s = await send(a.agentId, 60_000, now);
    await t.run(async (ctx) => {
      await ctx.tx.update(pipelineStage).set({ archivedAt: now }).where(and(eq(pipelineStage.tenantId, ctx.tenantId), eq(pipelineStage.key, 'opportunity')));
    });
    await enter(s.accountId, 'opportunity', new Date(now.getTime() - 30_000));
    await compute([a.agentId], now);
    expect(await row(a.agentId)).toMatchObject({ trustSample: 1, trust: trustOf([{ quality: 0.9, ageDays: 60_000 / 86_400_000 }], 0) });
  });

  it('losing a conflict drops trust by 0.01 at once, with a conflict_lost history row and no event', async () => {
    const ash = await agent();
    const d = `tl${Date.now().toString(36)}${++seq}-example.com`;
    const loser = await asSource(t, ash.agentId, (ctx) => submitArrival(ctx, { account: { name: `Conflict ${d}`, domain: d, employees: 1000 } }, { channel: 'api' }));
    await asSource(t, vendorId, (ctx) => submitArrival(ctx, { account: { name: `Conflict ${d}`, domain: d, employees: 2000 } }, { channel: 'api' }));
    await runOutbox(t.tenantId);
    const accountId = (await asSource(t, ash.agentId, (ctx) => getArrivalWithStatus(ctx, loser.arrivalId, { ownerName: false })))!.accountId!;
    const [c] = await asPerson((ctx) => listConflicts(ctx, accountId));
    const vendorFact = c!.facts.find((f) => f.value === 2000)!.id;
    await asPerson((ctx) => resolveConflict(ctx, c!.id, vendorFact));
    await runOutbox(t.tenantId);

    for (const id of [ash.agentId, ash.personId]) {
      expect(await row(id)).toMatchObject({ trust: 0.59, trustPublished: 0.6, trustSample: 0 });
      const h = await history(id);
      expect(h.at(-1)).toMatchObject({ trust: 0.59, inputs: { cause: 'conflict_lost', conflictsLost: 1 } });
      expect(await trustEvents(id)).toEqual([]);
    }
    // A replay writes no feedback, so it recomputes nothing more.
    const before = (await history(ash.agentId)).length;
    await runOutbox(t.tenantId);
    expect(await history(ash.agentId)).toHaveLength(before);
    // The winner is untouched.
    expect((await row(vendorId)).trust).toBe(0.6);
  });

  it("a merged account's stage credit reaches the sources of the survivor's arrivals (Review Focus 5)", async () => {
    const x = await agent();
    const y = await agent();
    const now = NOW();
    const merged = await send(x.agentId, 120_000, now);
    const survivor = await send(y.agentId, 120_000, now);
    await enter(merged.accountId, 'won', new Date(now.getTime() - 30_000));
    await compute([x.agentId, y.agentId], now);
    expect(await row(x.agentId)).toMatchObject({ trustSample: 1, trustWon: 1 });
    expect(await row(y.agentId)).toMatchObject({ trustSample: 0 });

    await t.run((ctx) => mergeAccounts({ ...ctx, access: { userId: 'usr_leader', sourceId: x.personId, dataLimit: { kind: 'all' } } }, survivor.accountId, merged.accountId));
    await runOutbox(t.tenantId);
    await compute([x.agentId, y.agentId], new Date(now.getTime() + 1000));
    expect(await row(x.agentId)).toMatchObject({ trustSample: 1, trustWon: 1 });
    expect(await row(y.agentId)).toMatchObject({ trustSample: 1, trustWon: 1 });
  });

  it('seedIntakeDefaults schedules the nightly job at 01:00 UTC', async () => {
    await t.run((ctx) => seedIntakeDefaults(ctx));
    const rows = await t.run((ctx) => ctx.tx.execute<{ cron: string }>(sql`select cron from platform.schedule where tenant_id = ${ctx.tenantId} and job_name = 'intake.trust'`));
    expect([...rows].map((r) => r.cron)).toEqual(['0 1 * * *']);
  });

  it("another tenant's compute neither reads nor writes this tenant's rows", async () => {
    const a = await agent();
    const now = NOW();
    const s = await send(a.agentId, 60_000, now);
    await enter(s.accountId, 'won', new Date(now.getTime() - 30_000));
    const other = await freshTenant();
    const res = await other.run((ctx) => computeTrust(ctx, { cause: 'outcomes', sourceIds: [a.agentId], now }));
    expect(res).toEqual([]);
    const all = await other.run((ctx) => computeTrust(ctx, { cause: 'outcomes', now }));
    expect(all.every((r) => r.sampleSize === 0)).toBe(true);
    expect(await history(a.agentId)).toHaveLength(0);
    expect(await row(a.agentId)).toMatchObject({ trust: 0.6, trustSample: 0 });
  });
});

