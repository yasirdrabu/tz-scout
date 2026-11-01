import { and, eq, lt } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { enqueueJob } from '@/platform/events/outbox';
import { briefDraftJob } from '../contracts/jobs';
import { brief } from '../db/schema';
import { briefWhere, isFrozen, settleStuck, STALE_DRAFT_MS } from './brief';

const SWEEP_LIMIT = 500;

/**
 * `playbooks.brief.sweep`: a draft still `drafting` after STALE_DRAFT_MS lost its job (it dead-lettered or its run
 * died). One with requests left to draft, and allowed to draft (not frozen, or a manual request is waiting), is
 * queued again; any other is settled. Returns how many of each.
 */
export async function sweepBriefs(ctx: ModuleContext, now: Date): Promise<{ queued: number; settled: number }> {
  const stuck = await ctx.tx
    .select()
    .from(brief)
    .where(and(eq(brief.tenantId, ctx.tenantId), eq(brief.draftState, 'drafting'), lt(brief.updatedAt, new Date(now.getTime() - STALE_DRAFT_MS))))
    .limit(SWEEP_LIMIT)
    .for('update', { skipLocked: true });
  let queued = 0;
  let settled = 0;
  for (const row of stuck) {
    const manual = row.manualSeq > row.draftedSeq;
    if (row.requestedSeq > row.draftedSeq && (manual || !isFrozen(row))) {
      await ctx.tx.update(brief).set({ updatedAt: now }).where(briefWhere(ctx, row.accountId));
      await enqueueJob(ctx, briefDraftJob, { accountId: row.accountId, manual, includeEdited: row.pendingIncludeEdited, seq: row.requestedSeq });
      queued++;
    } else {
      await settleStuck(ctx, row, now);
      settled++;
    }
  }
  return { queued, settled };
}
