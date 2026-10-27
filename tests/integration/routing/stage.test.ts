import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moveStage, publishReviewSnapshot, reviewChanged, stageChanged } from '@/modules/routing';
import { accountReview, assignment, stageChange } from '@/modules/routing/db/schema';
import type { ModuleContext } from '@/platform/context';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { freshTenant } from '../offers/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;
let other: Awaited<ReturnType<typeof freshTenant>>;

beforeAll(async () => {
  t = await freshTenant();
  other = await freshTenant();
});
afterAll(closeDbs);

const seedReview = (tn: typeof t, stage = 'arrived') =>
  tn.run(async (ctx) => {
    const accountId = newId('acc');
    await ctx.tx.insert(accountReview).values({ tenantId: ctx.tenantId, accountId, statusKey: 'unvetted', stage });
    return accountId;
  });

const review = (tn: typeof t, accountId: string) =>
  tn.run(async (ctx) => (await ctx.tx.select().from(accountReview).where(eq(accountReview.accountId, accountId)))[0]!);

const events = async (tenantId: string, type: string, accountId: string) =>
  (await adminDb.select().from(outbox).where(and(eq(outbox.tenantId, tenantId))))
    .map((r) => r.payload as { type: string; data: { accountId?: string } })
    .filter((e) => e.type === type && e.data.accountId === accountId);

describe('moveStage', () => {
  it('moves once for a cause, writes history and publishes the stage and review events', async () => {
    const accountId = await seedReview(t);
    const first = await t.run((ctx) => moveStage(ctx, accountId, 'reviewed', 'evt_one'));
    expect(first).toEqual({ from: 'arrived', to: 'reviewed' });
    const again = await t.run((ctx) => moveStage(ctx, accountId, 'reviewed', 'evt_one'));
    expect(again).toBeNull();

    expect((await review(t, accountId)).stage).toBe('reviewed');
    const rows = await t.run((ctx) => ctx.tx.select().from(stageChange).where(eq(stageChange.accountId, accountId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromStage: 'arrived', toStage: 'reviewed', causeEventId: 'evt_one' });
    expect(await events(t.tenantId, stageChanged.type, accountId)).toHaveLength(1);
    expect(await events(t.tenantId, reviewChanged.type, accountId)).toHaveLength(0); // the calling write publishes the snapshot
  });

  it('ignores a redelivery of the same cause when an earlier event moved the stage on', async () => {
    const accountId = await seedReview(t);
    await t.run((ctx) => moveStage(ctx, accountId, 'assigned', 'evt_a'));
    await t.run((ctx) => moveStage(ctx, accountId, 'assignment_declined', 'evt_d'));
    expect((await review(t, accountId)).stage).toBe('reviewed');
    expect(await t.run((ctx) => moveStage(ctx, accountId, 'assigned', 'evt_a'))).toBeNull();
    expect((await review(t, accountId)).stage).toBe('reviewed');
  });

  it('moves once when the same cause is delivered at the same time', async () => {
    const accountId = await seedReview(t);
    const results = await Promise.all([
      t.run((ctx) => moveStage(ctx, accountId, 'reviewed', 'evt_race')),
      t.run((ctx) => moveStage(ctx, accountId, 'reviewed', 'evt_race')),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await t.run((ctx) => ctx.tx.select().from(stageChange).where(eq(stageChange.accountId, accountId)));
    expect(rows).toHaveLength(1);
  });

  it('writes nothing when the stage does not move', async () => {
    const accountId = await seedReview(t, 'declined');
    expect(await t.run((ctx) => moveStage(ctx, accountId, 'assigned', 'evt_late'))).toBeNull();
    expect(await t.run((ctx) => moveStage(ctx, accountId, 'withdrawn', 'evt_w'))).toBeNull();
    const rows = await t.run((ctx) => ctx.tx.select().from(stageChange).where(eq(stageChange.accountId, accountId)));
    expect(rows).toEqual([]);
    expect((await review(t, accountId)).version).toBe(1);
  });

  it('does nothing for an account without a review', async () => {
    expect(await t.run((ctx) => moveStage(ctx, newId('acc'), 'reviewed', 'evt_x'))).toBeNull();
  });
});

describe('publishReviewSnapshot', () => {
  const assign = (ctx: ModuleContext, accountId: string, sellerUserId: string, status: string, acceptedHow: string | null = null) =>
    ctx.tx.insert(assignment).values({ id: newId('asg'), tenantId: ctx.tenantId, accountId, sellerUserId, assignedBy: 'usr_lead', status, acceptedHow });

  it('bumps the version once per call and publishes the snapshot', async () => {
    const accountId = await seedReview(t);
    await t.run((ctx) => publishReviewSnapshot(ctx, accountId));
    expect((await review(t, accountId)).version).toBe(2);
    await t.run((ctx) => publishReviewSnapshot(ctx, accountId));
    expect((await review(t, accountId)).version).toBe(3);
    const sent = await events(t.tenantId, reviewChanged.type, accountId);
    expect(sent.map((e) => (e.data as unknown as { version: number }).version)).toEqual([2, 3]);
  });

  it('builds the owner, past sellers, open assignment, stage and flags from routing rows', async () => {
    const accountId = await seedReview(t, 'assigned');
    await t.run(async (ctx) => {
      await assign(ctx, accountId, 'usr_declined', 'declined');
      await assign(ctx, accountId, 'usr_replaced', 'replaced');
      await assign(ctx, accountId, 'usr_old', 'withdrawn', 'seller');
      await assign(ctx, accountId, 'usr_auto', 'replaced', 'auto_timeout');
      await assign(ctx, accountId, 'usr_now', 'accepted');
      await ctx.tx
        .update(accountReview)
        .set({ flags: { newFrom: { sourceId: 'src_x', at: '2026-10-27T00:00:00.000Z' }, declinedBySeller: { assignmentId: 'asg_1', sellerUserId: 'usr_declined', sellerName: 'Mike', reasonKey: 'other', reasonLabel: 'Other', at: '2026-10-26T00:00:00.000Z' } } })
        .where(eq(accountReview.accountId, accountId));
    });
    const snap = await t.run((ctx) => publishReviewSnapshot(ctx, accountId));
    expect(snap).toEqual({
      reviewStatusKey: 'unvetted',
      ownerUserId: 'usr_now',
      ownerHistoryUserIds: expect.arrayContaining(['usr_old', 'usr_auto']),
      hasOpenAssignment: true,
      stage: 'assigned',
      reviewFlags: ['declined_by_seller', 'new_from'],
    });
    expect(snap.ownerHistoryUserIds).toHaveLength(2); // a pending assignment that was declined or replaced is not ownership
  });

  it('shows no owner when nothing is open', async () => {
    const accountId = await seedReview(t);
    await t.run((ctx) => assign(ctx, accountId, 'usr_gone', 'replaced', 'crm_activity'));
    const snap = await t.run((ctx) => publishReviewSnapshot(ctx, accountId));
    expect(snap).toMatchObject({ ownerUserId: null, ownerHistoryUserIds: ['usr_gone'], hasOpenAssignment: false, reviewFlags: [] });
  });

  it('allows one open assignment per account', async () => {
    const accountId = await seedReview(t);
    await t.run((ctx) => assign(ctx, accountId, 'usr_1', 'pending'));
    await expect(t.run((ctx) => ctx.tx.transaction((sp) => sp.insert(assignment).values({ id: newId('asg'), tenantId: ctx.tenantId, accountId, sellerUserId: 'usr_2', assignedBy: 'usr_lead', status: 'accepted' })))).rejects.toThrow();
  });
});

describe('row level security', () => {
  it('hides one tenant review rows from another', async () => {
    const accountId = await seedReview(t);
    const seen = await other.run((ctx) => ctx.tx.select().from(accountReview).where(eq(accountReview.accountId, accountId)));
    expect(seen).toEqual([]);
  });
});
