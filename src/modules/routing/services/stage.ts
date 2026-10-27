import { and, eq } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { stageChanged } from '../contracts/events';
import { stageSchema, type Stage } from '../contracts/types';
import { accountReview, stageChange } from '../db/schema';
import { nextStage, type StageEvent } from '../domain/stages';
import { publishReviewSnapshot } from './snapshot';

/**
 * Applies a stage event to an account. Writes `stage_change` and publishes `routing.stage.changed`
 * only on a real move; a repeat of the same `causeId` is ignored, even when two deliveries race
 * (the unique index on the cause decides). Returns the move, or null when nothing moved.
 */
export async function moveStage(
  ctx: ModuleContext,
  accountId: string,
  event: StageEvent,
  causeId: string,
): Promise<{ from: Stage; to: Stage } | null> {
  const [review] = await ctx.tx
    .select({ stage: accountReview.stage })
    .from(accountReview)
    .where(and(eq(accountReview.tenantId, ctx.tenantId), eq(accountReview.accountId, accountId)))
    .for('update');
  if (!review) return null;

  const from = stageSchema.parse(review.stage);
  const to = nextStage(from, event);
  if (!to) return null;

  const inserted = await ctx.tx
    .insert(stageChange)
    .values({ id: newId('stc'), tenantId: ctx.tenantId, accountId, fromStage: from, toStage: to, causeEventId: causeId })
    .onConflictDoNothing()
    .returning({ id: stageChange.id });
  if (inserted.length === 0) return null;

  await ctx.tx
    .update(accountReview)
    .set({ stage: to, stageChangedAt: new Date() })
    .where(and(eq(accountReview.tenantId, ctx.tenantId), eq(accountReview.accountId, accountId)));
  await publish(ctx, stageChanged, { accountId, from, to, causeEventId: causeId });
  await publishReviewSnapshot(ctx, accountId);
  return { from, to };
}
