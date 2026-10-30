import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeAccounts } from '@/modules/accounts';
import { assign, changeStatus, reviewChanged, routingAccountMerged, setInsights, statusChanged } from '@/modules/routing';
import { accountReview, assignment, reviewStatusDef, stageChange, statusChange } from '@/modules/routing/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { arrivedAccount, asPerson, member, resolved, routingTenant, summaryOf, type Tenant } from './helpers';

let t: Tenant;
let seller: string;

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
});
afterAll(closeDbs);

const reviewOf = async (accountId: string) =>
  (await t.run((ctx) => ctx.tx.select().from(accountReview).where(eq(accountReview.accountId, accountId))))[0]!;
const assignmentsOf = (accountId: string) =>
  t.run((ctx) => ctx.tx.select().from(assignment).where(eq(assignment.accountId, accountId)).orderBy(assignment.assignedAt, assignment.id));
const events = async (type: string, accountId: string) =>
  (await adminDb.select().from(outbox).where(and(eq(outbox.tenantId, t.tenantId))).orderBy(outbox.seq))
    .map((r) => r.payload as { type: string; data: Record<string, unknown> })
    .filter((e) => e.type === type && e.data.accountId === accountId)
    .map((e) => e.data);
const rejects = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; message: string }) => ({ status: e.status, title: e.message }));

describe('review rows from arrivals (Ruling 5)', () => {
  it('starts at the arrival initial status when it is active, else unvetted, with stage arrived', async () => {
    const a = await arrivedAccount(t, { initialReviewStatusKey: 'needs_review' });
    const b = await arrivedAccount(t, { initialReviewStatusKey: 'no_such_status' });
    expect(await reviewOf(a)).toMatchObject({ statusKey: 'needs_review', stage: 'arrived', version: 2 });
    expect(await reviewOf(b)).toMatchObject({ statusKey: 'unvetted', stage: 'arrived' });
    expect((await summaryOf(t, a)).reviewStatusKey).toBe('needs_review');
  });

  it('a later arrival leaves the row alone when nothing is assigned', async () => {
    const a = await arrivedAccount(t);
    await resolved(t, a, { initialReviewStatusKey: 'needs_review' });
    expect(await reviewOf(a)).toMatchObject({ statusKey: 'unvetted', version: 2 });
  });

  it('a later arrival on an assigned account sets "New from" (Ruling 7)', async () => {
    const a = await arrivedAccount(t);
    await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    await runOutbox(t.tenantId);
    await resolved(t, a, { sourceChain: { personSourceId: 'src_person', agentSourceId: 'src_agent' } });
    expect((await reviewOf(a)).flags.newFrom).toMatchObject({ sourceId: 'src_agent' });
    expect((await summaryOf(t, a)).reviewFlags).toEqual(['new_from']);
  });
});

describe('changeStatus (REV-E1-S2)', () => {
  it('records from, to, who, note and reason, publishes status.changed and moves the stage (AC1)', async () => {
    const a = await arrivedAccount(t);
    await asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'reviewed', note: 'Looks right' }));
    const [row] = await t.run((ctx) => ctx.tx.select().from(statusChange).where(eq(statusChange.accountId, a)));
    expect(row).toMatchObject({ fromKey: 'unvetted', toKey: 'reviewed', note: 'Looks right', reasonKey: null, by: t.actor.id });
    expect(await events(statusChanged.type, a)).toEqual([
      { accountId: a, from: 'unvetted', to: 'reviewed', countsAsReviewed: true, isDeclined: false, returnsToSource: false, note: 'Looks right', reasonKey: null, by: t.actor.id },
    ]);
    expect(await reviewOf(a)).toMatchObject({ statusKey: 'reviewed', stage: 'reviewed', statusChangedBy: t.actor.id });
    expect(await events(reviewChanged.type, a)).toHaveLength(2); // creation, then this change
    await runOutbox(t.tenantId);
    expect(await summaryOf(t, a)).toMatchObject({ reviewStatusKey: 'reviewed', stage: 'reviewed' });
  });

  it('a decline needs a reason, and Other needs a note (AC2)', async () => {
    const a = await arrivedAccount(t);
    expect(await rejects(asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'declined' })))).toEqual({ status: 400, title: 'Pick a reason' });
    expect(await rejects(asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'declined', reasonKey: 'not_my_territory' })))).toEqual({ status: 400, title: 'Pick a reason' });
    expect(await rejects(asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'declined', reasonKey: 'other' })))).toEqual({ status: 400, title: 'Add a note for Other.' });
    await asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'declined', reasonKey: 'duplicate' }));
    expect(await reviewOf(a)).toMatchObject({ statusKey: 'declined', stage: 'declined' });
  });

  it('send back needs a note (AC3)', async () => {
    const a = await arrivedAccount(t);
    await t.run((ctx) =>
      ctx.tx
        .insert(reviewStatusDef)
        .values({ id: newId('rsd'), tenantId: ctx.tenantId, key: 'needs_info', label: 'Needs more info', order: 5, returnsToSource: true })
        .onConflictDoNothing(),
    );
    expect(await rejects(asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'needs_info' })))).toEqual({ status: 400, title: 'Say what the source should fix' });
    await asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'needs_info', note: 'Send the website' }));
    expect((await reviewOf(a)).statusKey).toBe('needs_info');
  });

  it('refuses a status that is not on the list', async () => {
    const a = await arrivedAccount(t);
    expect(await rejects(asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'nope' })))).toEqual({ status: 400, title: 'Pick a review status from your list.' });
  });

  it('reopening a declined account needs a note and goes to Needs review, stage arrived', async () => {
    const a = await arrivedAccount(t);
    await asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'declined', reasonKey: 'bad_data' }));
    expect(await rejects(asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'needs_review' })))).toEqual({
      status: 400,
      title: "Add a note saying why you're reopening it.",
    });
    await asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'reviewed', note: 'They fixed the data' }));
    expect(await reviewOf(a)).toMatchObject({ statusKey: 'needs_review', stage: 'arrived' });
  });

  it('declining with an open assignment withdraws it and the stage ends at declined (Ruling 14)', async () => {
    const a = await arrivedAccount(t);
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    await t.run((ctx) => ctx.tx.update(assignment).set({ status: 'accepted', acceptedHow: 'seller' }).where(eq(assignment.id, made.id)));
    await t.run((ctx) => ctx.tx.update(accountReview).set({ stage: 'assigned' }).where(eq(accountReview.accountId, a)));
    await asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'declined', reasonKey: 'not_a_fit' }));
    expect((await assignmentsOf(a)).map((x) => x.status)).toEqual(['withdrawn']);
    expect(await reviewOf(a)).toMatchObject({ statusKey: 'declined', stage: 'declined', currentAssignmentId: null });
    const moves = await t.run((ctx) => ctx.tx.select().from(stageChange).where(eq(stageChange.accountId, a)));
    expect(moves.map((m) => `${m.fromStage}>${m.toStage}`).sort()).toEqual(['arrived>reviewed', 'assigned>declined']);
    expect(await events('routing.assignment.withdrawn', a)).toHaveLength(1);
    await runOutbox(t.tenantId);
    expect(await summaryOf(t, a)).toMatchObject({ ownerUserId: null, hasOpenAssignment: false, stage: 'declined', ownerHistoryUserIds: [seller] });
  });
});

describe('setInsights (REV-E1-S3-AC1)', () => {
  it('keeps the text with author and time', async () => {
    const a = await arrivedAccount(t);
    await asPerson(t, (ctx) => setInsights(ctx, a, 'Their CIO used to work with us.'));
    expect(await reviewOf(a)).toMatchObject({ insights: 'Their CIO used to work with us.', insightsBy: t.actor.id, insightsAt: expect.any(Date), version: 3 });
    expect(await rejects(asPerson(t, (ctx) => setInsights(ctx, a, 'x'.repeat(4001))))).toMatchObject({ status: 400 });
  });
});

describe('every write', () => {
  it('needs a person and is 404 for an account the person cannot see', async () => {
    const a = await arrivedAccount(t);
    const hidden = { dataLimit: { kind: 'practices' as const, ids: ['prc_elsewhere'] } };
    const writes = [
      (ctx: ModuleContext): Promise<unknown> => changeStatus(ctx, a, { to: 'reviewed' }),
      (ctx: ModuleContext): Promise<unknown> => setInsights(ctx, a, 'x'),
      (ctx: ModuleContext): Promise<unknown> => assign(ctx, a, { sellerUserId: seller }),
    ];
    for (const w of writes) {
      expect(await rejects(asPerson(t, w, hidden))).toMatchObject({ status: 404 });
      expect(await rejects(t.run(w))).toMatchObject({ status: 403 });
    }
  });
});

describe('merge', () => {
  it('moves the merged account open assignment to a survivor that has none', async () => {
    const survivor = await arrivedAccount(t, { name: 'Survivor Co' });
    const merged = await arrivedAccount(t, { name: 'Merged Co' });
    const made = await asPerson(t, (ctx) => assign(ctx, merged, { sellerUserId: seller }));
    await asPerson(t, (ctx) => mergeAccounts(ctx, survivor, merged));
    await runOutbox(t.tenantId);
    expect((await assignmentsOf(survivor)).map((x) => [x.id, x.status])).toEqual([[made.id, 'pending']]);
    expect(await reviewOf(survivor)).toMatchObject({ currentAssignmentId: made.id, mergedInto: null });
    expect(await reviewOf(merged)).toMatchObject({ mergedInto: survivor, currentAssignmentId: null });
    expect(await t.run((ctx) => ctx.tx.select().from(statusChange).where(eq(statusChange.accountId, merged)))).toEqual([]);
    expect(await summaryOf(t, survivor)).toMatchObject({ ownerUserId: seller, hasOpenAssignment: true });
    expect(await rejects(asPerson(t, (ctx) => setInsights(ctx, merged, 'x')))).toMatchObject({ status: 404 });
  });

  it('withdraws the merged account open assignment when the survivor has one', async () => {
    const survivor = await arrivedAccount(t, { name: 'Survivor Two' });
    const merged = await arrivedAccount(t, { name: 'Merged Two' });
    const other = await member(t, 'seller');
    const kept = await asPerson(t, (ctx) => assign(ctx, survivor, { sellerUserId: seller }));
    const dropped = await asPerson(t, (ctx) => assign(ctx, merged, { sellerUserId: other }));
    await asPerson(t, (ctx) => mergeAccounts(ctx, survivor, merged));
    await runOutbox(t.tenantId);
    const rows = await assignmentsOf(survivor);
    expect(rows.find((r) => r.id === kept.id)?.status).toBe('pending');
    expect(rows.find((r) => r.id === dropped.id)?.status).toBe('withdrawn');
    expect((await events('routing.assignment.withdrawn', merged)).map((e) => e.assignmentId)).toEqual([dropped.id]);
    expect(await summaryOf(t, survivor)).toMatchObject({ ownerUserId: seller });
  });

  it('withdraws the merged account open assignment when the survivor is declined (Ruling 14)', async () => {
    const survivor = await arrivedAccount(t, { name: 'Declined Survivor' });
    const merged = await arrivedAccount(t, { name: 'Assigned Merged' });
    await asPerson(t, (ctx) => changeStatus(ctx, survivor, { to: 'declined', reasonKey: 'duplicate' }));
    const made = await asPerson(t, (ctx) => assign(ctx, merged, { sellerUserId: seller }));
    await t.run((ctx) => ctx.tx.update(assignment).set({ status: 'accepted', acceptedHow: 'seller' }).where(eq(assignment.id, made.id)));
    const before = { s: (await events(reviewChanged.type, survivor)).length, m: (await events(reviewChanged.type, merged)).length };
    await asPerson(t, (ctx) => mergeAccounts(ctx, survivor, merged));
    await runOutbox(t.tenantId);
    expect((await assignmentsOf(survivor)).filter((r) => r.status === 'pending' || r.status === 'accepted')).toEqual([]);
    expect((await events('routing.assignment.withdrawn', merged)).map((e) => e.assignmentId)).toEqual([made.id]);
    expect(await reviewOf(survivor)).toMatchObject({ statusKey: 'declined', stage: 'declined', currentAssignmentId: null });
    expect(await summaryOf(t, survivor)).toMatchObject({ ownerUserId: null, hasOpenAssignment: false });
    // One snapshot per account for the merge.
    expect((await events(reviewChanged.type, survivor)).length - before.s).toBe(1);
    expect((await events(reviewChanged.type, merged)).length - before.m).toBe(1);

    // A redelivery of the merge changes nothing.
    const versions = { s: (await reviewOf(survivor)).version, m: (await reviewOf(merged)).version };
    const outboxBefore = (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId))).length;
    const envelope = {
      id: newId('evt'),
      type: 'accounts.account.merged',
      schemaVersion: 1,
      tenantId: t.tenantId,
      occurredAt: new Date().toISOString(),
      actor: t.actor,
      correlationId: newId('cor'),
      data: { survivorId: survivor, mergedId: merged, mergedBy: t.actor.id },
    };
    await t.run((ctx) => routingAccountMerged.handle(envelope, ctx));
    expect({ s: (await reviewOf(survivor)).version, m: (await reviewOf(merged)).version }).toEqual(versions);
    expect((await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId))).length).toBe(outboxBefore);
  });

  it('a survivor with no review row starts from the merged row: status, stage, insights and lead offer', async () => {
    const merged = await arrivedAccount(t, { name: 'Row Source' });
    await asPerson(t, (ctx) => changeStatus(ctx, merged, { to: 'reviewed' }));
    await asPerson(t, (ctx) => setInsights(ctx, merged, 'Met them at a conference'));
    await t.run((ctx) => ctx.tx.update(accountReview).set({ leadOfferOverrideId: 'off_lead' }).where(eq(accountReview.accountId, merged)));
    const survivor = await arrivedAccount(t, { name: 'No Row Yet' });
    await t.run((ctx) => ctx.tx.delete(accountReview).where(eq(accountReview.accountId, survivor)));
    await asPerson(t, (ctx) => mergeAccounts(ctx, survivor, merged));
    await runOutbox(t.tenantId);
    expect(await reviewOf(survivor)).toMatchObject({
      statusKey: 'reviewed',
      stage: 'reviewed',
      insights: 'Met them at a conference',
      insightsBy: t.actor.id,
      leadOfferOverrideId: 'off_lead',
    });
  });
});

describe('"New from" and unchanged status', () => {
  it('"New from" ends with the assignment (declining withdraws it)', async () => {
    const a = await arrivedAccount(t);
    await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    await resolved(t, a, { sourceChain: { agentSourceId: 'src_agent' } });
    expect((await reviewOf(a)).flags.newFrom).toBeDefined();
    await asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'declined', reasonKey: 'duplicate' }));
    const { handoff: _handoff, ...flags } = (await reviewOf(a)).flags; // the CRM handoff state is not part of this assignment's flags
    expect(flags).toEqual({});
    await runOutbox(t.tenantId);
    expect((await summaryOf(t, a)).reviewFlags).toEqual([]);
  });

  it('changing to the current status writes nothing and returns the current state', async () => {
    const a = await arrivedAccount(t);
    const before = await reviewOf(a);
    const snap = await asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'unvetted' }));
    expect(snap).toMatchObject({ reviewStatusKey: 'unvetted', stage: 'arrived' });
    expect((await reviewOf(a)).version).toBe(before.version);
    expect(await t.run((ctx) => ctx.tx.select().from(statusChange).where(eq(statusChange.accountId, a)))).toEqual([]);
    expect(await events(statusChanged.type, a)).toEqual([]);
  });
});
