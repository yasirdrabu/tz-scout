import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountSummary } from '@/modules/accounts/db/schema';
import { getArrivalWithStatus, getBatch, listFeedback, recordFeedback, submitArrival, submitBatch } from '@/modules/intake';
import { arrival, sourceFeedback } from '@/modules/intake/db/schema';
import { assignmentDeclined, statusChanged } from '@/modules/routing/contracts/events';
import { addMember } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { seedUser } from '../tenancy/helpers';
import { asSource, freshTenant, personAndAgent, type Tenant } from './helpers';

let t: Tenant;
let ash: { personId: string; agentId: string };
let bo: { personId: string; agentId: string };

afterAll(closeDbs);
beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
  ash = await personAndAgent(t, 'Ash');
  bo = await personAndAgent(t, 'Bo');
});

let n = 0;
const domain = () => `fb${Date.now().toString(36)}${++n}-example.com`;
const send = (sourceId: string, d: string) =>
  asSource(t, sourceId, (ctx) => submitArrival(ctx, { account: { name: `Feedback ${d}`, domain: d } }, { channel: 'api' }));

/** Two sources send the same company, so one account has two arrivals with different chains. */
async function sharedAccount() {
  const d = domain();
  const a = await send(ash.agentId, d);
  const b = await send(bo.agentId, d);
  await runOutbox(t.tenantId);
  const row = await asSource(t, ash.agentId, (ctx) => getArrivalWithStatus(ctx, a.arrivalId, { ownerName: false }));
  return { accountId: row!.accountId!, arrivals: [a.arrivalId, b.arrivalId] };
}

const rowsFor = (accountId: string) => t.run((ctx) => ctx.tx.select().from(sourceFeedback).where(eq(sourceFeedback.accountId, accountId)));
const recordedEvents = () =>
  t.run(async (ctx) =>
    (await ctx.tx.select().from(outbox).where(eq(outbox.tenantId, ctx.tenantId))).filter(
      (r) => (r.payload as { type: string }).type === 'intake.feedback.recorded',
    ),
  );

const status = (accountId: string, over: Record<string, unknown> = {}) => ({
  accountId,
  from: 'reviewed',
  to: 'declined',
  countsAsReviewed: true,
  isDeclined: false,
  returnsToSource: false,
  note: null,
  reasonKey: null,
  by: 'usr_leader',
  ...over,
});

describe('feedback rows (SRC-E1-S4-AC1)', () => {
  it('a decline at review tells every source in the chains of the account arrivals, with reason and note', async () => {
    const { accountId, arrivals } = await sharedAccount();
    const before = (await recordedEvents()).length;
    await publishTestEvent(t.tenantId, statusChanged, status(accountId, { isDeclined: true, reasonKey: 'not_a_fit', note: 'Too small' }));
    await runOutbox(t.tenantId);

    const rows = await rowsFor(accountId);
    expect(rows.map((r) => r.sourceId).sort()).toEqual([ash.personId, ash.agentId, bo.personId, bo.agentId].sort());
    expect(rows.map((r) => r.arrivalId).sort()).toEqual([arrivals[0], arrivals[0], arrivals[1], arrivals[1]].sort());
    for (const r of rows) expect(r).toMatchObject({ kind: 'declined_at_review', reasonKey: 'not_a_fit', note: 'Too small', accountId });
    const events = (await recordedEvents()).slice(before).map((r) => (r.payload as { data: unknown }).data);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ accountId, kind: 'declined_at_review', reasonKey: 'not_a_fit', note: 'Too small' });
  });

  it('a send back writes sent_back with the note', async () => {
    const { accountId } = await sharedAccount();
    await publishTestEvent(t.tenantId, statusChanged, status(accountId, { to: 'needs_info', returnsToSource: true, note: 'Add a website' }));
    await runOutbox(t.tenantId);
    const rows = await rowsFor(accountId);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toMatchObject({ kind: 'sent_back', note: 'Add a website', reasonKey: null });
  });

  it('a status that neither declines nor returns to the source writes nothing', async () => {
    const { accountId } = await sharedAccount();
    await publishTestEvent(t.tenantId, statusChanged, status(accountId, { to: 'reviewed' }));
    await runOutbox(t.tenantId);
    expect(await rowsFor(accountId)).toHaveLength(0);
  });

  it('a seller decline writes declined_by_seller with the reason and note', async () => {
    const { accountId } = await sharedAccount();
    await publishTestEvent(t.tenantId, assignmentDeclined, {
      assignmentId: newId('asg'),
      accountId,
      sellerUserId: 'usr_seller',
      reasonKey: 'not_my_territory',
      note: 'West team',
    });
    await runOutbox(t.tenantId);
    const rows = await rowsFor(accountId);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toMatchObject({ kind: 'declined_by_seller', reasonKey: 'not_my_territory', note: 'West team' });
  });

  it('an arrival that did not resolve to the account gets no feedback', async () => {
    const { accountId, arrivals } = await sharedAccount();
    await t.run((ctx) => ctx.tx.update(arrival).set({ status: 'rejected' }).where(eq(arrival.id, arrivals[1]!)));
    await publishTestEvent(t.tenantId, statusChanged, status(accountId, { isDeclined: true, reasonKey: 'duplicate' }));
    await runOutbox(t.tenantId);
    expect((await rowsFor(accountId)).map((r) => r.sourceId).sort()).toEqual([ash.personId, ash.agentId].sort());
  });

  it('a replay adds no rows and publishes nothing', async () => {
    const { accountId } = await sharedAccount();
    const cause = newId('evt');
    const input = { accountId, kind: 'declined_at_review' as const, reasonKey: 'duplicate', note: null, causeEventId: cause };
    expect(await t.run((ctx) => recordFeedback(ctx, input))).toBe(4);
    const events = (await recordedEvents()).length;
    expect(await t.run((ctx) => recordFeedback(ctx, input))).toBe(0);
    expect(await rowsFor(accountId)).toHaveLength(4);
    expect((await recordedEvents()).length).toBe(events);
    // A different cause event is new feedback.
    expect(await t.run((ctx) => recordFeedback(ctx, { ...input, causeEventId: newId('evt') }))).toBe(4);
  });
});

describe('arrival detail', () => {
  it('shows stage, review status, owner name (with status:read) and the principal own feedback', async () => {
    const u = await seedUser({ signedIn: true });
    await t.run((ctx) => addMember(ctx, { email: u.email, role: 'seller' }));
    const { accountId, arrivals } = await sharedAccount();
    await t.run((ctx) =>
      ctx.tx.update(accountSummary).set({ stage: 'assigned', reviewStatusKey: 'reviewed', ownerUserId: u.id }).where(eq(accountSummary.accountId, accountId)),
    );
    await publishTestEvent(t.tenantId, statusChanged, status(accountId, { isDeclined: true, reasonKey: 'duplicate' }));
    await runOutbox(t.tenantId);

    const seen = await asSource(t, ash.agentId, (ctx) => getArrivalWithStatus(ctx, arrivals[0]!, { ownerName: true }));
    expect(seen).toMatchObject({ stage: 'assigned', reviewStatus: 'reviewed', ownerName: expect.any(String) });
    expect(seen!.feedback).toHaveLength(1);
    expect(seen!.feedback[0]).toMatchObject({ sourceId: ash.agentId, kind: 'declined_at_review', reasonKey: 'duplicate' });

    const noName = await asSource(t, ash.agentId, (ctx) => getArrivalWithStatus(ctx, arrivals[0]!, { ownerName: false }));
    expect(noName!.ownerName).toBeNull();
    expect(noName).toMatchObject({ stage: 'assigned', reviewStatus: 'reviewed' });
  });

  it('Review Focus 5: an arrival that is not the agent own is not found', async () => {
    const { arrivals } = await sharedAccount();
    const other = await personAndAgent(t, 'Cy');
    expect(await asSource(t, other.agentId, (ctx) => getArrivalWithStatus(ctx, arrivals[0]!, { ownerName: true }))).toBeNull();
  });
});

describe('feedback feed (SRC-E1-S4-AC2)', () => {
  it('lists the principal own source and children only, in pages', async () => {
    const { accountId } = await sharedAccount();
    await publishTestEvent(t.tenantId, statusChanged, status(accountId, { isDeclined: true, reasonKey: 'bad_data' }));
    await runOutbox(t.tenantId);
    const person = await asSource(t, ash.personId, (ctx) => listFeedback(ctx, { limit: 200 }));
    const agent = await asSource(t, ash.agentId, (ctx) => listFeedback(ctx, { limit: 200 }));
    const mine = (rows: { accountId: string; sourceId: string }[]) => rows.filter((r) => r.accountId === accountId).map((r) => r.sourceId).sort();
    expect(mine(person.data)).toEqual([ash.personId, ash.agentId].sort());
    expect(mine(agent.data)).toEqual([ash.agentId]);
    expect(agent.data.every((r) => r.sourceId === ash.agentId)).toBe(true);

    const first = await asSource(t, ash.agentId, (ctx) => listFeedback(ctx, { limit: 1 }));
    expect(first.data).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await asSource(t, ash.agentId, (ctx) => listFeedback(ctx, { limit: 1, cursor: first.nextCursor! }));
    expect(second.data[0]!.id).not.toBe(first.data[0]!.id);
  });

  it('since leaves out older rows, and a principal with no source gets an empty feed', async () => {
    const future = await asSource(t, ash.agentId, (ctx) => listFeedback(ctx, { since: new Date('2099-01-01') }));
    expect(future.data).toEqual([]);
    const none = await t.run((ctx) => listFeedback({ ...ctx, access: { userId: 'usr_x', dataLimit: { kind: 'all' } } }, {}));
    expect(none.data).toEqual([]);
  });
});

describe('batch counts by stage (SRC-E2-S3-AC1)', () => {
  it('counts the resolved arrivals by the stage of their accounts', async () => {
    const [d1, d2, d3] = [domain(), domain(), domain()];
    const out = await asSource(t, ash.agentId, (ctx) =>
      submitBatch(ctx, { name: `Stages ${++n}`, items: [d1, d2, d3].map((d) => ({ account: { name: d, domain: d, external_ref: d } })) }, { channel: 'webhook' }),
    );
    await runOutbox(t.tenantId);
    const setStage = async (ref: string, stage: string) =>
      t.run(async (ctx) => {
        const [a] = await ctx.tx.select({ accountId: arrival.accountId }).from(arrival).where(and(eq(arrival.batchId, out.batchId), eq(arrival.externalRef, ref)));
        await ctx.tx.update(accountSummary).set({ stage }).where(eq(accountSummary.accountId, a!.accountId!));
      });
    await setStage(d1, 'assigned');
    await setStage(d2, 'assigned');
    await setStage(d3, 'declined');
    const b = await asSource(t, ash.agentId, (ctx) => getBatch(ctx, out.batchId));
    expect(b!.countsByStage).toEqual({ assigned: 2, declined: 1 });
  });
});
