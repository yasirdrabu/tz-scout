import { and, eq } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { stageChanged } from '../contracts/events';
import { stageKeySchema } from '../contracts/types';
import { accountReview, stageChange } from '../db/schema';
import { moveFor, type StageSignal } from '../domain/pipeline';
import { eventSignals, type StageEvent } from '../domain/stages';
import { loadStageNames, loadStages } from './pipeline-stages';

/**
 * Applies what happened to an account (a `StageEvent`, or the signals themselves) to its workspace's
 * stages. Writes `stage_change` (with the stage names as they are now, and who and why for a move by
 * hand) and publishes `routing.stage.changed` only on a real move; a repeat of the same `causeId` is
 * ignored, even when two deliveries race (the unique index on the cause decides). Returns the move,
 * or null when nothing moved.
 *
 * It does not publish the review snapshot: the calling write does that once, at its end. One cause
 * moves an account at most once (unique on account and cause), so a write that needs two moves must
 * make one move or use distinct causes.
 */
export async function moveStage(
  ctx: ModuleContext,
  accountId: string,
  what: StageEvent | StageSignal[],
  causeId: string,
  opts: { by?: string; note?: string | null } = {},
): Promise<{ from: string; to: string } | null> {
  const [review] = await ctx.tx
    .select({ stage: accountReview.stage })
    .from(accountReview)
    .where(and(eq(accountReview.tenantId, ctx.tenantId), eq(accountReview.accountId, accountId)))
    .for('update');
  if (!review) return null;

  const from = stageKeySchema.parse(review.stage);
  const to = moveFor(from, typeof what === 'string' ? eventSignals(what) : what, await loadStages(ctx));
  if (!to) return null;

  const names = await loadStageNames(ctx);
  const fromName = names.get(from) ?? from;
  const toName = names.get(to) ?? to;
  const inserted = await ctx.tx
    .insert(stageChange)
    .values({ id: newId('stc'), tenantId: ctx.tenantId, accountId, fromStage: from, toStage: to, fromName, toName, by: opts.by ?? null, note: opts.note ?? null, causeEventId: causeId })
    .onConflictDoNothing()
    .returning({ id: stageChange.id });
  if (inserted.length === 0) return null;

  await ctx.tx
    .update(accountReview)
    .set({ stage: to, stageChangedAt: new Date() })
    .where(and(eq(accountReview.tenantId, ctx.tenantId), eq(accountReview.accountId, accountId)));
  await publish(ctx, stageChanged, { accountId, from, to, fromName, toName, causeEventId: causeId });
  return { from, to };
}
