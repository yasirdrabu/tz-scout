import { and, asc, eq, sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { reviewChanged } from '../contracts/events';
import type { ReviewFlag, ReviewSnapshot } from '../contracts/types';
import { stageSchema } from '../contracts/types';
import { accountReview, assignment } from '../db/schema';

const OPEN = ['pending', 'accepted'];

/**
 * Past sellers are those whose assignment was accepted (by them, by CRM activity or by timeout) and has since
 * ended; a pending assignment that was declined or replaced was never ownership.
 * Ends every write to an account's review: bumps `account_review.version` once, builds the snapshot
 * Accounts keeps (Ruling 1) from routing's own rows and publishes `routing.review.changed`.
 * The caller holds the `account_review` row lock.
 */
export async function publishReviewSnapshot(ctx: ModuleContext, accountId: string): Promise<ReviewSnapshot> {
  const [review] = await ctx.tx
    .update(accountReview)
    .set({ version: sql`${accountReview.version} + 1` })
    .where(and(eq(accountReview.tenantId, ctx.tenantId), eq(accountReview.accountId, accountId)))
    .returning();
  if (!review) throw new Error(`publishReviewSnapshot: no review for account ${accountId}`);
  const snapshot = await buildSnapshot(ctx, review);
  await publish(ctx, reviewChanged, { accountId, version: review.version, snapshot });
  return snapshot;
}

/** The snapshot as it stands, without a version bump or an event, for a call that changed nothing. */
export async function currentReviewSnapshot(ctx: ModuleContext, accountId: string): Promise<ReviewSnapshot> {
  const [review] = await ctx.tx
    .select()
    .from(accountReview)
    .where(and(eq(accountReview.tenantId, ctx.tenantId), eq(accountReview.accountId, accountId)));
  if (!review) throw new Error(`currentReviewSnapshot: no review for account ${accountId}`);
  return buildSnapshot(ctx, review);
}

async function buildSnapshot(ctx: ModuleContext, review: typeof accountReview.$inferSelect): Promise<ReviewSnapshot> {
  const accountId = review.accountId;
  const assignments = await ctx.tx
    .select({ sellerUserId: assignment.sellerUserId, status: assignment.status, acceptedHow: assignment.acceptedHow })
    .from(assignment)
    .where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.accountId, accountId)))
    .orderBy(asc(assignment.assignedAt), asc(assignment.id));
  const open = assignments.find((a) => OPEN.includes(a.status));
  const past = [...new Set(assignments.filter((a) => !OPEN.includes(a.status) && a.acceptedHow !== null).map((a) => a.sellerUserId))];

  const reviewFlags: ReviewFlag[] = [];
  if (review.flags.declinedBySeller) reviewFlags.push('declined_by_seller');
  if (review.flags.newFrom) reviewFlags.push('new_from');
  if (review.flags.handoff?.state === 'needs_decision') reviewFlags.push('handoff_needs_decision');
  if (review.flags.handoff?.state === 'failed') reviewFlags.push('handoff_failed');

  return {
    reviewStatusKey: review.statusKey,
    ownerUserId: open?.sellerUserId ?? null,
    ownerHistoryUserIds: past,
    hasOpenAssignment: !!open,
    stage: stageSchema.parse(review.stage),
    reviewFlags,
  };
}
