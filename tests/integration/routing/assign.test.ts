import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { approveOffer, createOffer, createPractice } from '@/modules/offers';
import { assign, assignmentCreated, bulk, changeStatus, previewAssign, registerOwnershipPreflight } from '@/modules/routing';
import { accountReview, assignment } from '@/modules/routing/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { runOutbox } from '../helpers/run-outbox';
import { completeOffer } from '../offers/helpers';
import { arrivedAccount, asPerson, member, routingTenant, summaryOf, type Tenant } from './helpers';

let t: Tenant;
let seller: string;

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
});
afterEach(() => registerOwnershipPreflight(null));
afterAll(closeDbs);

const reviewOf = async (accountId: string) =>
  (await t.run((ctx) => ctx.tx.select().from(accountReview).where(eq(accountReview.accountId, accountId))))[0]!;
const assignmentsOf = (accountId: string) =>
  t.run((ctx) => ctx.tx.select().from(assignment).where(eq(assignment.accountId, accountId)).orderBy(assignment.assignedAt, assignment.id));
const events = async (accountId: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq))
    .map((r) => r.payload as { type: string; data: Record<string, unknown> })
    .filter((e) => e.data.accountId === accountId && e.type.startsWith('routing.assignment.'));
const rejects = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; message: string }) => ({ status: e.status, title: e.message }));

describe('assign (REV-E2-S1)', () => {
  it('Approve and assign from Unvetted: the status and the owner both land in the summary (AC1)', async () => {
    const a = await arrivedAccount(t);
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller, notes: 'Call the CIO', leadOfferId: undefined }));
    expect(made).toMatchObject({ accountId: a, sellerUserId: seller, status: 'pending', ownershipDecision: 'assign' });
    expect(await reviewOf(a)).toMatchObject({ statusKey: 'reviewed', stage: 'reviewed', currentAssignmentId: made.id });
    const [created] = (await events(a)).filter((e) => e.type === assignmentCreated.type);
    expect(created!.data).toEqual({
      assignmentId: made.id,
      accountId: a,
      sellerUserId: seller,
      assignedBy: t.actor.id,
      templateId: null,
      offerId: null,
      notes: 'Call the CIO',
      ownershipDecision: 'assign',
      previousAssignmentId: null,
    });
    await runOutbox(t.tenantId);
    expect(await summaryOf(t, a)).toMatchObject({ reviewStatusKey: 'reviewed', ownerUserId: seller, hasOpenAssignment: true });
  });

  it('a stop from the preflight is a 409 with its message, unless the leader keeps their owner (AC2)', async () => {
    registerOwnershipPreflight({ check: async () => ({ result: 'stop', message: 'Open deal owned by Vijay: will not change owner' }) });
    const a = await arrivedAccount(t);
    expect(await rejects(asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller })))).toEqual({ status: 409, title: 'Open deal owned by Vijay: will not change owner' });
    expect(await assignmentsOf(a)).toEqual([]);
    expect((await reviewOf(a)).statusKey).toBe('unvetted');
    const preview = await asPerson(t, (ctx) => previewAssign(ctx, a, seller));
    expect(preview).toMatchObject({ preflight: { result: 'stop' }, approvesTo: { key: 'reviewed', label: 'Reviewed' }, replaces: null });
    const kept = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller, ownershipDecision: 'keep' }));
    expect(kept.ownershipDecision).toBe('keep');
    expect((await assignmentsOf(a))[0]!.ownershipDecision).toBe('keep');
  });

  it('a blocked preflight is a 409', async () => {
    registerOwnershipPreflight({ check: async () => ({ result: 'blocked', message: 'Ash has no HubSpot owner set. Set it in Members first.' }) });
    const a = await arrivedAccount(t);
    expect(await rejects(asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller, ownershipDecision: 'keep' })))).toMatchObject({ status: 409 });
  });

  it('assigning again replaces the open one, publishes withdrawn then created, and clears the seller decline flag', async () => {
    const a = await arrivedAccount(t);
    const other = await member(t, 'seller');
    const first = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    await t.run((ctx) =>
      ctx.tx
        .update(accountReview)
        .set({ flags: { declinedBySeller: { assignmentId: 'asg_x', sellerUserId: seller, sellerName: 'Mike', reasonKey: 'other', reasonLabel: 'Other', at: new Date().toISOString() } } })
        .where(eq(accountReview.accountId, a)),
    );
    const second = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: other, leadOfferId: undefined }));
    expect((await assignmentsOf(a)).map((x) => [x.id, x.status, x.previousAssignmentId])).toEqual([
      [first.id, 'replaced', null],
      [second.id, 'pending', first.id],
    ]);
    expect((await events(a)).map((e) => e.type)).toEqual(['routing.assignment.created', 'routing.assignment.withdrawn', 'routing.assignment.created']);
    expect((await events(a))[1]!.data).toMatchObject({ assignmentId: first.id, replacedBy: second.id });
    expect((await reviewOf(a)).flags).toEqual({});
  });

  it('refuses a declined account (Ruling 14), an invited seller and someone who cannot take assignments', async () => {
    const a = await arrivedAccount(t);
    await asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'declined', reasonKey: 'duplicate' }));
    expect(await rejects(asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller })))).toEqual({ status: 409, title: 'Reopen it before assigning.' });

    const b = await arrivedAccount(t);
    const invited = await member(t, 'seller', { invited: true });
    const operator = await member(t, 'operator');
    expect(await rejects(asPerson(t, (ctx) => assign(ctx, b, { sellerUserId: invited })))).toMatchObject({ status: 400 });
    expect(await rejects(asPerson(t, (ctx) => assign(ctx, b, { sellerUserId: operator })))).toMatchObject({ status: 400 });
    expect(await assignmentsOf(b)).toEqual([]);
  });

  it('stores the lead offer override and sends it as the offer', async () => {
    const a = await arrivedAccount(t);
    expect(await rejects(asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller, leadOfferId: 'off_missing' })))).toMatchObject({ status: 400 });
    const practice = await t.run((ctx) => createPractice(ctx, { name: 'Lead Practice', slug: `lead-${Date.now().toString(36)}` }));
    const offer = await t.run((ctx) => createOffer(ctx, { name: 'Lead Offer', practiceId: practice.id, ...completeOffer }));
    expect(await rejects(asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller, leadOfferId: offer.id })))).toMatchObject({ status: 400 }); // still a draft
    await t.run((ctx) => approveOffer(ctx, offer.id));
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller, leadOfferId: offer.id }));
    expect((await reviewOf(a)).leadOfferOverrideId).toBe(offer.id);
    expect((await events(a)).find((e) => e.data.assignmentId === made.id && e.type === assignmentCreated.type)!.data.offerId).toBe(offer.id);
  });

  it('two concurrent assigns give one open assignment, and both are recorded (Review Focus 3)', async () => {
    const a = await arrivedAccount(t);
    const other = await member(t, 'seller');
    const results = await Promise.allSettled([
      asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller })),
      asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: other })),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await assignmentsOf(a);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(rows.map((r) => r.status).sort()).toEqual(['pending', 'replaced']);
    expect((await reviewOf(a)).currentAssignmentId).toBe(rows.find((r) => r.status === 'pending')!.id);
  });
});

describe('bulk (REV-E2-S1-AC3)', () => {
  it('assigns the same seller to 3 accounts and reports each result', async () => {
    const accounts = [await arrivedAccount(t), await arrivedAccount(t), await arrivedAccount(t)];
    await asPerson(t, (ctx) => changeStatus(ctx, accounts[1]!, { to: 'declined', reasonKey: 'duplicate' }));
    const results = await asPerson(t, (ctx) => bulk(ctx, accounts, { kind: 'assign', sellerUserId: seller }));
    expect(results).toEqual([
      { accountId: accounts[0], ok: true },
      { accountId: accounts[1], ok: false, status: 409, message: 'Reopen it before assigning.' },
      { accountId: accounts[2], ok: true },
    ]);
    const open = await t.run((ctx) =>
      ctx.tx.select().from(assignment).where(and(inArray(assignment.accountId, accounts), eq(assignment.status, 'pending'))),
    );
    expect(open.map((r) => r.accountId).sort()).toEqual([accounts[0], accounts[2]].sort());
  });

  it('sets a status on many accounts', async () => {
    const accounts = [await arrivedAccount(t), await arrivedAccount(t)];
    const results = await asPerson(t, (ctx) => bulk(ctx, accounts, { kind: 'status', to: 'declined', reasonKey: 'wrong_timing' }));
    expect(results.every((r) => r.ok)).toBe(true);
    for (const a of accounts) expect((await reviewOf(a)).statusKey).toBe('declined');
  });

  it('refuses more than 50 accounts', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `acc_${i}`);
    expect(await rejects(asPerson(t, (ctx) => bulk(ctx, many, { kind: 'assign', sellerUserId: seller })))).toMatchObject({ status: 400 });
  });
});
