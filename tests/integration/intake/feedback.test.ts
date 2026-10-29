import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeAccounts } from '@/modules/accounts';
import { accountSummary } from '@/modules/accounts/db/schema';
import {
  feedbackForArrival,
  getArrivalWithStatus,
  getBatch,
  intakeSourceAccess,
  listFeedback,
  recordFeedback,
  registerSource,
  submitArrival,
  submitBatch,
} from '@/modules/intake';
import { arrival, sourceFeedback } from '@/modules/intake/db/schema';
import { assignmentDeclined, statusChanged } from '@/modules/routing/contracts/events';
import { addMember } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
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
let vendorId: string;

afterAll(closeDbs);
beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
  ash = await personAndAgent(t, 'Ash');
  bo = await personAndAgent(t, 'Bo');
  vendorId = await t.run(async (ctx) => (await registerSource(ctx, { kind: 'vendor', name: 'Feed Vendor' })).id);
});

let n = 0;
const domain = () => `fb${Date.now().toString(36)}${++n}-example.com`;
const send = (sourceId: string, d: string) =>
  asSource(t, sourceId, (ctx) => submitArrival(ctx, { account: { name: `Feedback ${d}`, domain: d } }, { channel: 'api' }));

/** The principal as the HTTP layer builds it: its own source with the sources below it. */
const asOwn = <T>(sourceId: string, fn: (ctx: ModuleContext) => Promise<T>) =>
  t.run(async (ctx) =>
    fn({ ...ctx, access: { sourceId, childSourceIds: await intakeSourceAccess.childSources(ctx, [sourceId]), dataLimit: { kind: 'own_source' } } }),
  );

/**
 * One account sent by Ash's agent twice, Bo's agent once and a vendor once: five distinct sources
 * (two persons, two agents, a vendor) over four arrivals.
 */
async function sharedAccount() {
  const d = domain();
  const a1 = await send(ash.agentId, d);
  const a2 = await send(ash.agentId, d);
  const b = await send(bo.agentId, d);
  const v = await send(vendorId, d);
  await runOutbox(t.tenantId);
  const row = await asSource(t, ash.agentId, (ctx) => getArrivalWithStatus(ctx, a1.arrivalId, { ownerName: false }));
  return { domain: d, accountId: row!.accountId!, arrivals: [a1.arrivalId, a2.arrivalId, b.arrivalId, v.arrivalId] };
}
const ALL_SOURCES = () => [ash.personId, ash.agentId, bo.personId, bo.agentId, vendorId].sort();

const rowsFor = (accountId: string) => t.run((ctx) => ctx.tx.select().from(sourceFeedback).where(eq(sourceFeedback.accountId, accountId)));
const recordedEvents = () =>
  t.run(async (ctx) =>
    (await ctx.tx.select().from(outbox).where(eq(outbox.tenantId, ctx.tenantId))).filter(
      (r) => (r.payload as { type: string }).type === 'intake.feedback.recorded',
    ),
  );
const eventsSince = async (before: number) => (await recordedEvents()).slice(before).map((r) => (r.payload as { data: Record<string, unknown> }).data);

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
  it('a decline at review writes one row and one event per distinct source, pinned to its latest arrival', async () => {
    const { accountId, arrivals } = await sharedAccount();
    const before = (await recordedEvents()).length;
    await publishTestEvent(t.tenantId, statusChanged, status(accountId, { isDeclined: true, reasonKey: 'not_a_fit', note: 'Too small' }));
    await runOutbox(t.tenantId);

    const rows = await rowsFor(accountId);
    // Ash's agent sent the account twice but is told once.
    expect(rows.map((r) => r.sourceId).sort()).toEqual(ALL_SOURCES());
    expect(Object.fromEntries(rows.map((r) => [r.sourceId, r.arrivalId]))).toEqual({
      [ash.personId]: arrivals[1],
      [ash.agentId]: arrivals[1],
      [bo.personId]: arrivals[2],
      [bo.agentId]: arrivals[2],
      [vendorId]: arrivals[3],
    });
    for (const r of rows) expect(r).toMatchObject({ kind: 'declined_at_review', reasonKey: 'not_a_fit', note: 'Too small', accountId });
    const events = await eventsSince(before);
    expect(events.map((e) => e.sourceId).sort()).toEqual(ALL_SOURCES());
    expect(events[0]).toMatchObject({ accountId, kind: 'declined_at_review', reasonKey: 'not_a_fit', note: 'Too small' });
  });

  it('a send back writes sent_back with the note', async () => {
    const { accountId } = await sharedAccount();
    await publishTestEvent(t.tenantId, statusChanged, status(accountId, { to: 'needs_info', returnsToSource: true, note: 'Add a website' }));
    await runOutbox(t.tenantId);
    const rows = await rowsFor(accountId);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r).toMatchObject({ kind: 'sent_back', note: 'Add a website', reasonKey: null });
  });

  it('a status that neither declines nor returns to the source writes nothing', async () => {
    const { accountId } = await sharedAccount();
    await publishTestEvent(t.tenantId, statusChanged, status(accountId, { to: 'reviewed' }));
    await runOutbox(t.tenantId);
    expect(await rowsFor(accountId)).toHaveLength(0);
  });

  it('a seller decline writes declined_by_seller with the reason and note, and publishes it', async () => {
    const { accountId } = await sharedAccount();
    const before = (await recordedEvents()).length;
    await publishTestEvent(t.tenantId, assignmentDeclined, {
      assignmentId: newId('asg'),
      accountId,
      sellerUserId: 'usr_seller',
      reasonKey: 'not_my_territory',
      note: 'West team',
    });
    await runOutbox(t.tenantId);
    const rows = await rowsFor(accountId);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r).toMatchObject({ kind: 'declined_by_seller', reasonKey: 'not_my_territory', note: 'West team' });
    const events = await eventsSince(before);
    expect(events).toHaveLength(5);
    for (const e of events) expect(e).toMatchObject({ accountId, kind: 'declined_by_seller', reasonKey: 'not_my_territory', note: 'West team' });
  });

  it('an arrival that did not resolve to the account gets no feedback', async () => {
    const { accountId, arrivals } = await sharedAccount();
    await t.run((ctx) => ctx.tx.update(arrival).set({ status: 'rejected' }).where(eq(arrival.id, arrivals[3]!)));
    await publishTestEvent(t.tenantId, statusChanged, status(accountId, { isDeclined: true, reasonKey: 'duplicate' }));
    await runOutbox(t.tenantId);
    expect((await rowsFor(accountId)).map((r) => r.sourceId).sort()).toEqual([ash.personId, ash.agentId, bo.personId, bo.agentId].sort());
  });

  it('a merged account\'s arrivals get the feedback of the survivor', async () => {
    const one = await sharedAccount();
    const two = await sharedAccount();
    await t.run((ctx) =>
      mergeAccounts({ ...ctx, access: { userId: 'usr_leader', sourceId: ash.personId, dataLimit: { kind: 'all' } } }, one.accountId, two.accountId),
    );
    await runOutbox(t.tenantId);
    await publishTestEvent(t.tenantId, statusChanged, status(one.accountId, { isDeclined: true, reasonKey: 'duplicate' }));
    await runOutbox(t.tenantId);
    const rows = await rowsFor(one.accountId);
    expect(rows.map((r) => r.sourceId).sort()).toEqual(ALL_SOURCES());
    // The merged account's arrivals now belong to the survivor, so its last arrival is the pin.
    expect(rows.find((r) => r.sourceId === vendorId)!.arrivalId).toBe(two.arrivals[3]);
  });

  it('feedback given before a merge moves to the survivor and shows on its arrivals, and a replay changes nothing', async () => {
    const one = await sharedAccount();
    const two = await sharedAccount();
    await t.run((ctx) => recordFeedback(ctx, { accountId: two.accountId, kind: 'declined_at_review', reasonKey: 'duplicate', note: null, causeEventId: newId('evt') }));
    const merge = () => runOutbox(t.tenantId);
    await t.run((ctx) =>
      mergeAccounts({ ...ctx, access: { userId: 'usr_leader', sourceId: ash.personId, dataLimit: { kind: 'all' } } }, one.accountId, two.accountId),
    );
    await merge();
    expect(await rowsFor(two.accountId)).toHaveLength(0);
    expect(await rowsFor(one.accountId)).toHaveLength(5);
    // The arrival that came in under the merged account now belongs to the survivor, and so does its feedback.
    const shown = await t.run((ctx) => feedbackForArrival(ctx, two.arrivals[3]!));
    expect(shown).toEqual([expect.objectContaining({ kind: 'declined_at_review', reasonKey: 'duplicate' })]);
  });

  it('a replay adds no rows and publishes nothing, even after a newer arrival', async () => {
    const { accountId, domain: sent } = await sharedAccount();
    const cause = newId('evt');
    const input = { accountId, kind: 'declined_at_review' as const, reasonKey: 'duplicate', note: null, causeEventId: cause };
    expect(await t.run((ctx) => recordFeedback(ctx, input))).toBe(5);
    const events = (await recordedEvents()).length;
    await send(ash.agentId, sent);
    await runOutbox(t.tenantId);
    expect(await t.run((ctx) => recordFeedback(ctx, input))).toBe(0);
    expect(await rowsFor(accountId)).toHaveLength(5);
    expect((await recordedEvents()).length).toBe(events);
    // A different cause event is new feedback.
    expect(await t.run((ctx) => recordFeedback(ctx, { ...input, causeEventId: newId('evt') }))).toBe(5);
  });
});

describe('arrival detail', () => {
  it('shows stage, review status, the owner\'s exact name (with status:read) and feedback', async () => {
    const u = await seedUser({ signedIn: true });
    await t.run((ctx) => addMember(ctx, { email: u.email, role: 'seller' }));
    const { accountId, arrivals } = await sharedAccount();
    await t.run((ctx) =>
      ctx.tx.update(accountSummary).set({ stage: 'assigned', reviewStatusKey: 'reviewed', ownerUserId: u.id }).where(eq(accountSummary.accountId, accountId)),
    );
    await publishTestEvent(t.tenantId, statusChanged, status(accountId, { isDeclined: true, reasonKey: 'duplicate' }));
    await runOutbox(t.tenantId);

    const seen = await asSource(t, ash.agentId, (ctx) => getArrivalWithStatus(ctx, arrivals[0]!, { ownerName: true }));
    expect(seen).toMatchObject({ stage: 'assigned', reviewStatus: 'reviewed', ownerName: u.email.split('@')[0] });
    expect(seen!.feedback).toEqual([{ kind: 'declined_at_review', reasonKey: 'duplicate', note: null, at: expect.any(Date) }]);

    const noName = await asSource(t, ash.agentId, (ctx) => getArrivalWithStatus(ctx, arrivals[0]!, { ownerName: false }));
    expect(noName!.ownerName).toBeNull();
    expect(noName).toMatchObject({ stage: 'assigned', reviewStatus: 'reviewed' });
  });

  it('shows one entry per cause to the person source, whose agent sent the arrival, and to a leader who sees everything', async () => {
    const { accountId, arrivals } = await sharedAccount();
    await publishTestEvent(t.tenantId, statusChanged, status(accountId, { isDeclined: true, reasonKey: 'bad_data', note: 'Wrong site' }));
    await publishTestEvent(t.tenantId, assignmentDeclined, { assignmentId: newId('asg'), accountId, sellerUserId: 'usr_s', reasonKey: 'other', note: 'Busy' });
    await runOutbox(t.tenantId);
    const expected = [
      { kind: 'declined_at_review', reasonKey: 'bad_data', note: 'Wrong site', at: expect.any(Date) },
      { kind: 'declined_by_seller', reasonKey: 'other', note: 'Busy', at: expect.any(Date) },
    ];
    // The arrival's chain is Ash and Ash's agent: two rows per cause, one entry per cause.
    const viaPerson = await asOwn(ash.personId, (ctx) => getArrivalWithStatus(ctx, arrivals[0]!, { ownerName: false }));
    expect(viaPerson!.feedback).toEqual(expected);
    const leader = await t.run((ctx) =>
      getArrivalWithStatus({ ...ctx, access: { userId: 'usr_leader', dataLimit: { kind: 'all' } } }, arrivals[0]!, { ownerName: false }),
    );
    expect(leader!.feedback).toEqual(expected);
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
    const person = await asOwn(ash.personId, (ctx) => listFeedback(ctx, { limit: 200 }));
    const agent = await asOwn(ash.agentId, (ctx) => listFeedback(ctx, { limit: 200 }));
    const mine = (rows: { accountId: string; sourceId: string }[]) => rows.filter((r) => r.accountId === accountId).map((r) => r.sourceId).sort();
    expect(mine(person.data)).toEqual([ash.personId, ash.agentId].sort());
    expect(mine(agent.data)).toEqual([ash.agentId]);
    expect(agent.data.every((r) => r.sourceId === ash.agentId)).toBe(true);

    const first = await asOwn(ash.agentId, (ctx) => listFeedback(ctx, { limit: 1 }));
    expect(first.data).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await asOwn(ash.agentId, (ctx) => listFeedback(ctx, { limit: 1, cursor: first.nextCursor! }));
    expect(second.data[0]!.id).not.toBe(first.data[0]!.id);
  });

  it('since leaves out older rows and keeps newer ones, and a principal with no source gets an empty feed', async () => {
    const { accountId } = await sharedAccount();
    await publishTestEvent(t.tenantId, statusChanged, status(accountId, { isDeclined: true, reasonKey: 'bad_data' }));
    await runOutbox(t.tenantId);
    const future = await asOwn(ash.agentId, (ctx) => listFeedback(ctx, { since: new Date('2099-01-01') }));
    expect(future.data).toEqual([]);
    const past = await asOwn(ash.agentId, (ctx) => listFeedback(ctx, { since: new Date('2020-01-01'), limit: 200 }));
    expect(past.data.some((r) => r.accountId === accountId)).toBe(true);
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
        const [a] = await ctx.tx.select({ accountId: arrival.accountId }).from(arrival).where(eq(arrival.externalRef, ref));
        await ctx.tx.update(accountSummary).set({ stage }).where(eq(accountSummary.accountId, a!.accountId!));
      });
    await setStage(d1, 'assigned');
    await setStage(d2, 'assigned');
    await setStage(d3, 'declined');
    const b = await asSource(t, ash.agentId, (ctx) => getBatch(ctx, out.batchId));
    expect(b!.countsByStage).toEqual({ assigned: 2, declined: 1 });
  });
});
