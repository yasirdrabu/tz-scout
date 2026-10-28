import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accept,
  assign,
  assignmentAccepted,
  assignmentCreated,
  assignmentDeclined,
  assignmentWithdrawn,
  autoAccept,
  changeStatus,
  decline,
  listQueue,
  markSeen,
  reviewChanged,
  withdraw,
} from '@/modules/routing';
import { accountReview, assignment, routingSetting } from '@/modules/routing/db/schema';
import { memberRemoved } from '@/modules/tenancy/contracts/events';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { arrivedAccount, asPerson, member, resolved, routingTenant, summaryOf, type Tenant } from './helpers';

let t: Tenant;
let seller: string;
let leader: string;

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  leader = await member(t, 'leader');
});
afterAll(closeDbs);

const asSeller = <T,>(fn: Parameters<typeof asPerson<T>>[1], userId = seller) => asPerson(t, fn, { userId, dataLimit: { kind: 'own_accounts' } });
const reviewOf = async (accountId: string) => (await t.run((ctx) => ctx.tx.select().from(accountReview).where(eq(accountReview.accountId, accountId))))[0]!;
const assignmentOf = async (id: string) => (await t.run((ctx) => ctx.tx.select().from(assignment).where(eq(assignment.id, id))))[0]!;
const published = async (tn: Tenant, accountId: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, tn.tenantId)).orderBy(outbox.seq))
    .map((r) => r.payload as { type: string; data: Record<string, unknown> })
    .filter((e) => e.data.accountId === accountId);
const snapshotCount = async (tn: Tenant, accountId: string) => (await published(tn, accountId)).filter((e) => e.type === reviewChanged.type).length;
const rejects = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; message: string }) => ({ status: e.status, title: e.message }));
/** A pending assignment for `seller` on a fresh reviewed account, assigned by the owner. */
const assigned = async (to = seller) => {
  const a = await arrivedAccount(t);
  const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: to }));
  return { a, id: made.id };
};

describe('accept and decline (REV-E2-S2, REV-E2-S3)', () => {
  it('a seller limited to their own accounts accepts right after assignment, before any consumer runs (Ruling 17)', async () => {
    const { a, id } = await assigned();
    await asSeller((ctx) => accept(ctx, id));
    expect(await assignmentOf(id)).toMatchObject({ status: 'accepted', acceptedHow: 'seller' });
    expect(await reviewOf(a)).toMatchObject({ stage: 'assigned', currentAssignmentId: id });
    const events = await published(t, a);
    expect(events.find((e) => e.type === assignmentAccepted.type)!.data).toEqual({ assignmentId: id, accountId: a, sellerUserId: seller, acceptedHow: 'seller' });
    expect(await snapshotCount(t, a)).toBe(3); // creation, approve-and-assign, accept
    await runOutbox(t.tenantId);
    expect(await summaryOf(t, a)).toMatchObject({ ownerUserId: seller, stage: 'assigned' });
  });

  it('another seller gets 404 on accept, decline and markSeen', async () => {
    const { a, id } = await assigned();
    const other = await member(t, 'seller');
    expect(await rejects(asSeller((ctx) => accept(ctx, id), other))).toMatchObject({ status: 404 });
    expect(await rejects(asSeller((ctx) => decline(ctx, id, { reasonKey: 'not_a_fit' }), other))).toMatchObject({ status: 404 });
    expect(await rejects(asSeller((ctx) => markSeen(ctx, a), other))).toMatchObject({ status: 404 });
    expect((await assignmentOf(id)).status).toBe('pending');
  });

  it('decline needs a reason from the assignment list, and Other needs a note (AC1)', async () => {
    const { id } = await assigned();
    expect(await rejects(asSeller((ctx) => decline(ctx, id, { reasonKey: '' })))).toEqual({ status: 400, title: 'Pick a reason' });
    expect(await rejects(asSeller((ctx) => decline(ctx, id, { reasonKey: 'duplicate' })))).toEqual({ status: 400, title: 'Pick a reason' });
    expect(await rejects(asSeller((ctx) => decline(ctx, id, { reasonKey: 'other', note: '  ' })))).toEqual({ status: 400, title: 'Add a note for Other.' });
    expect((await assignmentOf(id)).status).toBe('pending');
  });

  it('a decline returns the account to the leader with the flag, status unchanged, stage reviewed (AC2, Ruling 15)', async () => {
    const { a, id } = await assigned();
    await asSeller((ctx) => decline(ctx, id, { reasonKey: 'not_my_territory' }));
    expect(await assignmentOf(id)).toMatchObject({ status: 'declined', declineReasonKey: 'not_my_territory', declineNote: null });
    const review = await reviewOf(a);
    expect(review).toMatchObject({ statusKey: 'reviewed', stage: 'reviewed', currentAssignmentId: null });
    expect(review.flags.declinedBySeller).toMatchObject({ assignmentId: id, sellerUserId: seller, reasonKey: 'not_my_territory', reasonLabel: 'Not my territory' });
    expect(review.flags.declinedBySeller!.sellerName).toBeTruthy();
    expect((await published(t, a)).find((e) => e.type === assignmentDeclined.type)!.data).toEqual({ assignmentId: id, accountId: a, sellerUserId: seller, reasonKey: 'not_my_territory', note: null });
    await runOutbox(t.tenantId);
    expect(await summaryOf(t, a)).toMatchObject({ ownerUserId: null, hasOpenAssignment: false, reviewStatusKey: 'reviewed' });
    const queue = await asPerson(t, (ctx) => listQueue(ctx, {}));
    expect(queue.data.find((r) => r.accountId === a)?.flags.declinedBySeller?.reasonLabel).toBe('Not my territory');
  });

  it('a decline after an accept, and an accept after a decline, are refused (Review Focus 4)', async () => {
    const first = await assigned();
    await asSeller((ctx) => accept(ctx, first.id));
    expect(await rejects(asSeller((ctx) => decline(ctx, first.id, { reasonKey: 'not_a_fit' })))).toMatchObject({ status: 409 });

    const second = await assigned();
    await asSeller((ctx) => decline(ctx, second.id, { reasonKey: 'other', note: 'Not our region' }));
    expect(await rejects(asSeller((ctx) => accept(ctx, second.id)))).toMatchObject({ status: 409 });
    expect(await rejects(asSeller((ctx) => decline(ctx, second.id, { reasonKey: 'not_a_fit' })))).toMatchObject({ status: 409 });
    expect(await assignmentOf(second.id)).toMatchObject({ status: 'declined', declineNote: 'Not our region' });
    await runOutbox(t.tenantId);
    expect(await summaryOf(t, second.a)).toMatchObject({ ownerUserId: null, stage: 'reviewed', reviewStatusKey: 'reviewed' });
    expect(await reviewOf(second.a)).toMatchObject({ stage: 'reviewed', currentAssignmentId: null });
  });

  it('assigning the account again clears the decline flag', async () => {
    const { a, id } = await assigned();
    await asSeller((ctx) => decline(ctx, id, { reasonKey: 'not_a_fit' }));
    await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    expect((await reviewOf(a)).flags.declinedBySeller).toBeUndefined();
  });
});

describe('autoAccept (Ruling 6, REV-E2-S2-AC3)', () => {
  let at: Tenant;
  let aSeller: string;
  beforeAll(async () => {
    at = await routingTenant();
    aSeller = await member(at, 'seller');
  });
  const days = (n: number | null) => at.run((ctx) => ctx.tx.update(routingSetting).set({ autoAcceptWorkingDays: n }).where(eq(routingSetting.tenantId, ctx.tenantId)));
  const pendingAt = async (when: string) => {
    const a = await arrivedAccount(at);
    const made = await asPerson(at, (ctx) => assign(ctx, a, { sellerUserId: aSeller }));
    await at.run((ctx) => ctx.tx.update(assignment).set({ assignedAt: new Date(when) }).where(eq(assignment.id, made.id)));
    return { a, id: made.id };
  };
  const statusOf = async (id: string) => (await at.run((ctx) => ctx.tx.select().from(assignment).where(eq(assignment.id, id))))[0]!;
  const clear = () => at.run((ctx) => ctx.tx.update(assignment).set({ status: 'withdrawn' }).where(eq(assignment.status, 'pending')));

  it('accepts after 3 working days, not a minute before', async () => {
    await clear();
    await days(3);
    const { a, id } = await pendingAt('2026-10-19T10:00:00Z'); // Monday
    expect(await at.run((ctx) => autoAccept(ctx, new Date('2026-10-22T09:59:00Z')))).toBe(0);
    expect((await statusOf(id)).status).toBe('pending');
    expect(await at.run((ctx) => autoAccept(ctx, new Date('2026-10-22T10:00:00Z')))).toBe(1);
    expect(await statusOf(id)).toMatchObject({ status: 'accepted', acceptedHow: 'auto_timeout' });
    expect((await at.run((ctx) => ctx.tx.select().from(accountReview).where(eq(accountReview.accountId, a))))[0]!.stage).toBe('assigned');
    const events = await published(at, a);
    expect(events.find((e) => e.type === assignmentAccepted.type)!.data).toMatchObject({ assignmentId: id, acceptedHow: 'auto_timeout' });
    expect(events.filter((e) => e.type === reviewChanged.type)).toHaveLength(3);
  });

  it('a Friday afternoon assignment is still pending on Monday morning', async () => {
    await clear();
    await days(2);
    const { id } = await pendingAt('2026-10-23T15:00:00Z'); // Friday
    expect(await at.run((ctx) => autoAccept(ctx, new Date('2026-10-26T09:00:00Z')))).toBe(0);
    expect(await at.run((ctx) => autoAccept(ctx, new Date('2026-10-27T14:59:00Z')))).toBe(0);
    expect(await at.run((ctx) => autoAccept(ctx, new Date('2026-10-27T15:00:00Z')))).toBe(1);
    expect((await statusOf(id)).acceptedHow).toBe('auto_timeout');
  });

  it('does nothing when the setting is off', async () => {
    await clear();
    await days(null);
    const { id } = await pendingAt('2026-01-05T10:00:00Z');
    expect(await at.run((ctx) => autoAccept(ctx, new Date('2026-12-01T10:00:00Z')))).toBe(0);
    expect((await statusOf(id)).status).toBe('pending');
  });

  it('accepts at most 500 per run, oldest first', async () => {
    await clear();
    await days(1);
    const ids = await at.run(async (ctx) => {
      const rows = Array.from({ length: 502 }, (_, i) => ({
        id: newId('asg'),
        tenantId: ctx.tenantId,
        accountId: newId('acc'),
        sellerUserId: aSeller,
        assignedBy: at.actor.id,
        assignedAt: new Date(Date.UTC(2026, 0, 5, 0, 0, i)), // Monday 5 January, a second apart
      }));
      await ctx.tx.insert(accountReview).values(rows.map((r) => ({ tenantId: r.tenantId, accountId: r.accountId, statusKey: 'reviewed', stage: 'reviewed', currentAssignmentId: r.id })));
      await ctx.tx.insert(assignment).values(rows);
      return rows.map((r) => r.id);
    });
    const now = new Date('2026-02-02T00:00:00Z');
    expect(await at.run((ctx) => autoAccept(ctx, now))).toBe(500);
    const left = await at.run((ctx) => ctx.tx.select({ id: assignment.id }).from(assignment).where(and(eq(assignment.status, 'pending'))));
    expect(left.map((r) => r.id).sort()).toEqual([ids[500]!, ids[501]!].sort());
    expect(await at.run((ctx) => autoAccept(ctx, now))).toBe(2);
  }, 120_000);

  it('a decline racing auto-accept ends in exactly one outcome (Review Focus 4)', async () => {
    await clear();
    await days(1);
    for (let i = 0; i < 3; i++) {
      const { a, id } = await pendingAt('2026-01-05T10:00:00Z');
      const [decl, auto] = await Promise.allSettled([
        asPerson(at, (ctx) => decline(ctx, id, { reasonKey: 'not_a_fit' }), { userId: aSeller, dataLimit: { kind: 'own_accounts' } }),
        at.run((ctx) => autoAccept(ctx, new Date('2026-02-02T00:00:00Z'))),
      ]);
      const row = await statusOf(id);
      expect(['accepted', 'declined']).toContain(row.status);
      if (row.status === 'declined') {
        expect(decl!.status).toBe('fulfilled');
        expect(auto).toMatchObject({ status: 'fulfilled', value: 0 });
        expect(row.acceptedHow).toBeNull();
      } else {
        expect(decl!.status).toBe('rejected');
        expect(row.acceptedHow).toBe('auto_timeout');
      }
      const events = (await published(at, a)).map((e) => e.type);
      expect(events.filter((x) => x === assignmentAccepted.type).length + events.filter((x) => x === assignmentDeclined.type).length).toBe(1);
      await clear();
    }
  });
});

describe('withdraw (REV-E2 Rules, REV-E2-S4)', () => {
  it('the assigner withdraws a pending assignment; the stage stays reviewed', async () => {
    const { a, id } = await assigned();
    await asPerson(t, (ctx) => withdraw(ctx, id));
    expect(await assignmentOf(id)).toMatchObject({ status: 'withdrawn' });
    expect(await reviewOf(a)).toMatchObject({ stage: 'reviewed', currentAssignmentId: null });
    expect((await published(t, a)).find((e) => e.type === assignmentWithdrawn.type)!.data).toEqual({ assignmentId: id, accountId: a, by: t.actor.id, replacedBy: null });
    expect(await snapshotCount(t, a)).toBe(3);
  });

  it('withdrawing an accepted assignment returns the stage to reviewed (Ruling 16)', async () => {
    const { a, id } = await assigned();
    await asSeller((ctx) => accept(ctx, id));
    await asPerson(t, (ctx) => withdraw(ctx, id));
    expect(await reviewOf(a)).toMatchObject({ stage: 'reviewed', currentAssignmentId: null });
    await runOutbox(t.tenantId);
    expect(await summaryOf(t, a)).toMatchObject({ ownerUserId: null, stage: 'reviewed' });
  });

  it('only the assigner or an owner may withdraw, and only an open assignment', async () => {
    const { id } = await assigned();
    expect(await rejects(asPerson(t, (ctx) => withdraw(ctx, id), { userId: leader }))).toMatchObject({ status: 403 });
    expect(await rejects(asPerson(t, (ctx) => withdraw(ctx, 'asg_missing')))).toMatchObject({ status: 404 });
    await asPerson(t, (ctx) => withdraw(ctx, id));
    expect(await rejects(asPerson(t, (ctx) => withdraw(ctx, id)))).toMatchObject({ status: 409 });

    // A leader assigns; the owner (the tenant's first member) may still withdraw it.
    const a = await arrivedAccount(t);
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }), { userId: leader });
    await asPerson(t, (ctx) => withdraw(ctx, made.id));
    expect((await assignmentOf(made.id)).status).toBe('withdrawn');
  });

  it('withdraw and reassign publishes withdrawn then created, with one snapshot', async () => {
    const { a, id } = await assigned();
    const other = await member(t, 'seller');
    const before = await snapshotCount(t, a);
    const result = await asPerson(t, (ctx) => withdraw(ctx, id, { reassignTo: other }));
    expect(result.reassigned).toMatchObject({ accountId: a, sellerUserId: other, status: 'pending' });
    const types = (await published(t, a)).map((e) => e.type).filter((x) => x === assignmentWithdrawn.type || x === assignmentCreated.type);
    expect(types).toEqual([assignmentCreated.type, assignmentWithdrawn.type, assignmentCreated.type]);
    expect(await snapshotCount(t, a)).toBe(before + 1);
    expect((await assignmentOf(id)).status).toBe('replaced');
    expect((await reviewOf(a)).currentAssignmentId).toBe(result.reassigned!.id);
  });

  it('a refused reassign leaves the first assignment open', async () => {
    const { id } = await assigned();
    expect(await rejects(asPerson(t, (ctx) => withdraw(ctx, id, { reassignTo: 'usr_nobody' })))).toMatchObject({ status: 400 });
    expect((await assignmentOf(id)).status).toBe('pending');
  });
});

describe('markSeen (Ruling 7)', () => {
  it('only the assigned seller clears "New from"', async () => {
    const { a, id } = await assigned();
    await resolved(t, a, { sourceChain: { personSourceId: 'src_someone' } });
    expect((await reviewOf(a)).flags.newFrom).toBeDefined();
    const other = await member(t, 'seller');
    expect(await rejects(asSeller((ctx) => markSeen(ctx, a), other))).toMatchObject({ status: 404 });
    expect(await rejects(asPerson(t, (ctx) => markSeen(ctx, a)))).toMatchObject({ status: 404 });
    const before = await snapshotCount(t, a);
    const snap = await asSeller((ctx) => markSeen(ctx, a));
    expect(snap.reviewFlags).not.toContain('new_from');
    expect((await reviewOf(a)).flags.newFrom).toBeUndefined();
    expect(await snapshotCount(t, a)).toBe(before + 1);
    // Nothing left to clear: no new snapshot.
    await asSeller((ctx) => markSeen(ctx, a));
    expect(await snapshotCount(t, a)).toBe(before + 1);
    expect((await assignmentOf(id)).status).toBe('pending');
  });
});

describe('tenancy.member.removed', () => {
  it('withdraws that seller\'s open assignments, one snapshot per account, and leaves others alone', async () => {
    const gone = await member(t, 'seller');
    const first = await assigned(gone);
    const second = await assigned(gone);
    await asSeller((ctx) => accept(ctx, second.id), gone);
    const kept = await assigned(seller);
    const before = [await snapshotCount(t, first.a), await snapshotCount(t, second.a)];

    await publishTestEvent(t.tenantId, memberRemoved, { userId: gone, removedBy: t.actor.id });
    await runOutbox(t.tenantId);

    expect((await assignmentOf(first.id)).status).toBe('withdrawn');
    expect((await assignmentOf(second.id)).status).toBe('withdrawn');
    expect((await assignmentOf(kept.id)).status).toBe('pending');
    expect(await reviewOf(second.a)).toMatchObject({ stage: 'reviewed', currentAssignmentId: null });
    expect([await snapshotCount(t, first.a), await snapshotCount(t, second.a)]).toEqual([before[0]! + 1, before[1]! + 1]);
    expect(await summaryOf(t, second.a)).toMatchObject({ ownerUserId: null, hasOpenAssignment: false });
    expect((await published(t, first.a)).find((e) => e.type === assignmentWithdrawn.type)!.data).toMatchObject({ by: t.actor.id, replacedBy: null });
  });
});

describe('declined accounts', () => {
  it('withdrawing after the account was declined is refused as not open', async () => {
    const { a, id } = await assigned();
    await asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'declined', reasonKey: 'duplicate' }));
    expect((await assignmentOf(id)).status).toBe('withdrawn');
    expect(await rejects(asPerson(t, (ctx) => withdraw(ctx, id)))).toMatchObject({ status: 409 });
  });
});
