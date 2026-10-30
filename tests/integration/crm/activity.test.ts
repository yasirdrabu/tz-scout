import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { upsertFromArrival } from '@/modules/accounts';
import { activityObserved, checkFollowThrough, followThrough, hubspotMock, pollActivity, seedMockCrm, syncAccount, syncJob, syncOwners } from '@/modules/crm';
import { activity, followThrough as followThroughTable, handoff, link } from '@/modules/crm/db/schema';
import { mockAddActivity, mockCompleteTask, setMockFailure } from '@/modules/crm/fixtures';
import { callLog } from '@/modules/integrations/db/schema';
import { assign } from '@/modules/routing';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { asPerson, domain, member, resolved, routingTenant, type Tenant } from '../routing/helpers';

let t: Tenant;
let seller: string;

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  await t.run((ctx) => seedMockCrm(ctx));
  await t.run((ctx) => syncOwners(ctx));
});
afterAll(closeDbs);

const sellerOwner = () => `mock-${seller}`;
const DAY = 86_400_000;

/** An account assigned to the seller and pushed to the mock, with `before` emails already on the company. */
async function handedOff(tenant: Tenant = t, sellerId: string = seller, before = 0): Promise<string> {
  const arrivalId = newId('evt').replace('evt_', 'arr_');
  const d = domain();
  if (before) {
    const co = await tenant.run((ctx) => hubspotMock(ctx).upsertCompany({ domain: d, name: d, ownerExternalId: null, replaceableOwner: true, properties: {} }));
    for (let i = 0; i < before; i++) {
      await tenant.run((ctx) => mockAddActivity(ctx, { companyExternalId: co.externalId, kind: 'email', occurredAt: new Date(Date.now() - DAY) }));
    }
  }
  const { accountId } = await tenant.run((ctx) =>
    upsertFromArrival(ctx, {
      arrivalId,
      receivedAt: new Date(),
      sourceChain: {},
      account: { name: 'Activity Co', domain: d },
      people: [{ firstName: 'Ana', lastName: 'Act', title: 'CTO', email: `ana.${newId('acc').slice(-6).toLowerCase()}@act.example` }],
      signals: [],
      facts: [],
      research: {},
      soleProprietor: false,
      externalIds: [],
    }),
  );
  await resolved(tenant, accountId, { arrivalId, resolution: 'created' });
  await asPerson(tenant, (ctx) => assign(ctx, accountId, { sellerUserId: sellerId }));
  await runOutbox(tenant.tenantId);
  return accountId;
}

const handoffOf = async (a: string, tenant: Tenant = t) => (await tenant.run((ctx) => ctx.tx.select().from(handoff).where(eq(handoff.accountId, a))))[0]!;
const rows = (a: string) => t.run((ctx) => ctx.tx.select().from(activity).where(eq(activity.accountId, a)));
const outboxOf = async () =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq)).map((r) => r.payload as { type: string; data: Record<string, unknown> });
const observed = async (a: string) => (await outboxOf()).filter((e) => e.type === activityObserved.type && e.data.accountId === a).map((e) => e.data);
const sync = (a: string, now = new Date()) => t.run((ctx) => syncAccount(ctx, a, now));
const addActivity = (companyExternalId: string, kind: 'email' | 'reply' | 'call' | 'meeting', actorOwnerExternalId?: string) =>
  t.run((ctx) => mockAddActivity(ctx, { companyExternalId, kind, actorOwnerExternalId }));

describe('follow-through and activity (CRM-E5-S1, S2)', () => {
  it('counts only what came after the push and publishes one event per new activity (CRM-E5-S1-AC3)', async () => {
    const a = await handedOff(t, seller, 2);
    const h = await handoffOf(a);
    expect(h.status).toBe('completed');
    await addActivity(h.companyExternalId!, 'reply');
    await addActivity(h.companyExternalId!, 'meeting');
    await sync(a);
    const ft = await t.run((ctx) => followThrough(ctx, a));
    expect(ft).toMatchObject({ emails: 1, meetings: 1, calls: 0, tasksTotal: 4, tasksDone: 0 });
    expect((await rows(a)).map((r) => r.kind).sort()).toEqual(['meeting', 'reply']);
    expect(await observed(a)).toHaveLength(2);
  });

  it('the same activity polled twice and synced again gives one row and one event (Review Focus 4)', async () => {
    const a = await handedOff();
    const h = await handoffOf(a);
    const ext = await addActivity(h.companyExternalId!, 'call');
    await t.run((ctx) => pollActivity(ctx, new Date()));
    await runOutbox(t.tenantId); // the syncs it queued
    await t.run((ctx) => pollActivity(ctx, new Date()));
    await runOutbox(t.tenantId);
    await sync(a);
    expect((await rows(a)).filter((r) => r.externalId === ext)).toHaveLength(1);
    expect((await observed(a)).filter((e) => e.externalId === ext)).toHaveLength(1);
  });

  it('an email by the seller owner carries actorUserId = the seller (CRM-E5-S2-AC3)', async () => {
    const a = await handedOff();
    const h = await handoffOf(a);
    const ext = await addActivity(h.companyExternalId!, 'email', sellerOwner());
    const stranger = await addActivity(h.companyExternalId!, 'email', 'mock-ow-unknown');
    await sync(a);
    const events = await observed(a);
    expect(events.find((e) => e.externalId === ext)).toMatchObject({ kind: 'email', actorCrmOwnerId: sellerOwner(), actorUserId: seller, handoffId: h.id, system: 'hubspot' });
    expect(events.find((e) => e.externalId === stranger)).toMatchObject({ actorCrmOwnerId: 'mock-ow-unknown', actorUserId: null });
  });

  it('completing the first-touch task gives one task_done with the task id', async () => {
    const a = await handedOff();
    const h = await handoffOf(a);
    const [first] = await t.run((ctx) => ctx.tx.select().from(link).where(and(eq(link.scoutType, 'task'), eq(link.scoutId, `${h.assignmentId}:first_touch`))));
    await sync(a);
    expect((await rows(a)).filter((r) => r.kind === 'task_done')).toHaveLength(0);
    await t.run((ctx) => mockCompleteTask(ctx, first!.externalId));
    await sync(a);
    await sync(a);
    const done = (await rows(a)).filter((r) => r.kind === 'task_done');
    expect(done).toHaveLength(1);
    expect(done[0]!.externalId).toBe(first!.externalId);
    expect((await observed(a)).filter((e) => e.kind === 'task_done')).toEqual([
      expect.objectContaining({ externalId: first!.externalId, taskExternalId: first!.externalId, handoffId: h.id }),
    ]);
    expect(await t.run((ctx) => followThrough(ctx, a))).toMatchObject({ tasksDone: 1 });
  });

  it('checkFollowThrough enqueues a crm.sync job', async () => {
    const a = await handedOff();
    await t.run((ctx) => checkFollowThrough(ctx, a));
    const queued = (await outboxOf()).filter((e) => e.type === `jobs.${syncJob.name}` && e.data.accountId === a);
    expect(queued).toHaveLength(1);
  });
});

describe('the activity poll (Ruling 17)', () => {
  it('takes at most the limit, oldest checked first, and skips handoffs older than 180 days', async () => {
    const t2 = await routingTenant();
    const s2 = await member(t2, 'seller');
    await t2.run((ctx) => seedMockCrm(ctx));
    await t2.run((ctx) => syncOwners(ctx));
    const [a, b, c] = [await handedOff(t2, s2), await handedOff(t2, s2), await handedOff(t2, s2)];
    const setChecked = (acc: string, ago: number) =>
      t2.run(async (ctx) => {
        const [h] = await ctx.tx.select().from(handoff).where(eq(handoff.accountId, acc));
        await ctx.tx.update(followThroughTable).set({ checkedAt: new Date(Date.now() - ago * DAY) }).where(eq(followThroughTable.handoffId, h!.id));
      });
    const checkedAt = async (acc: string) => {
      const h = await handoffOf(acc, t2);
      return t2.run(async (ctx) => (await ctx.tx.select().from(followThroughTable).where(eq(followThroughTable.handoffId, h.id)))[0]!.checkedAt!);
    };
    await setChecked(a, 1);
    await setChecked(b, 3);
    await setChecked(c, 2);
    const before = Date.now() - 1000;

    // Older than 180 days: nothing is read.
    expect(await t2.run((ctx) => pollActivity(ctx, new Date(Date.now() + 181 * DAY), 2))).toBe(0);

    expect(await t2.run((ctx) => pollActivity(ctx, new Date(), 2))).toBe(2);
    await runOutbox(t2.tenantId); // the syncs it queued
    expect((await checkedAt(b)).getTime()).toBeGreaterThan(before);
    expect((await checkedAt(c)).getTime()).toBeGreaterThan(before);
    expect((await checkedAt(a)).getTime()).toBeLessThan(before);
  });

  it('queues one crm.sync per due account and makes no CRM call itself (final review C1)', async () => {
    const t3 = await routingTenant();
    const s3 = await member(t3, 'seller');
    await t3.run((ctx) => seedMockCrm(ctx));
    await t3.run((ctx) => syncOwners(ctx));
    const [a, b] = [await handedOff(t3, s3), await handedOff(t3, s3)];
    const calls = async () => (await adminDb.select({ id: callLog.id }).from(callLog).where(eq(callLog.tenantId, t3.tenantId))).length;
    const before = await calls();
    expect(await t3.run((ctx) => pollActivity(ctx, new Date()))).toBe(2);
    expect(await calls()).toBe(before);
    expect((await unsentSyncs(t3)).sort()).toEqual([a, b].sort());
  });

  it('an account whose sync keeps failing does not stay first (final review C1)', async () => {
    const t4 = await routingTenant();
    const s4 = await member(t4, 'seller');
    await t4.run((ctx) => seedMockCrm(ctx));
    await t4.run((ctx) => syncOwners(ctx));
    const [a, b] = [await handedOff(t4, s4), await handedOff(t4, s4)];
    for (const [acc, ago] of [[a, 3], [b, 1]] as const) {
      await t4.run(async (ctx) => {
        const [h] = await ctx.tx.select().from(handoff).where(eq(handoff.accountId, acc));
        await ctx.tx.update(followThroughTable).set({ checkedAt: new Date(Date.now() - ago * DAY) }).where(eq(followThroughTable.handoffId, h!.id));
      });
    }
    const nextQueued = async () => {
      await t4.run((ctx) => pollActivity(ctx, new Date(), 1));
      const queued = await unsentSyncs(t4);
      await adminDb.update(outbox).set({ sentAt: new Date() }).where(and(eq(outbox.tenantId, t4.tenantId), isNull(outbox.sentAt)));
      return queued;
    };
    expect(await nextQueued()).toEqual([a]);
    await t4.run((ctx) => setMockFailure(ctx, 'readFollowThrough', '500', 5));
    await expect(t4.run((ctx) => syncAccount(ctx, a, new Date()))).rejects.toThrow();
    expect(await nextQueued()).toEqual([b]);
  });
});

/** The account ids of the tenant's crm.sync jobs not yet delivered, in outbox order. */
const unsentSyncs = async (tenant: Tenant) =>
  (await adminDb.select().from(outbox).where(and(eq(outbox.tenantId, tenant.tenantId), isNull(outbox.sentAt))).orderBy(outbox.seq))
    .map((r) => r.payload as { type: string; data: { accountId?: string } })
    .filter((e) => e.type === `jobs.${syncJob.name}`)
    .map((e) => e.data.accountId);
