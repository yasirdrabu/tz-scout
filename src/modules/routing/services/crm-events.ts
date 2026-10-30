import { and, desc, eq } from 'drizzle-orm';
import type { activityObserved, dealChanged, handoffCancelled, handoffCompleted, handoffFailed, handoffNeedsDecision } from '@/modules/crm/contracts/events';
import type { ModuleContext } from '@/platform/context';
import type { Envelope } from '@/platform/events/envelope';
import type { EventDef } from '@/platform/events/registry';
import type { HandoffFlag } from '../contracts/types';
import { accountReview, assignment } from '../db/schema';
import type { StageEvent } from '../domain/stages';
import { lockRow, openAssignment } from './review';
import { acceptLocked } from './respond';
import { publishReviewSnapshot } from './snapshot';
import { moveStage } from './stage';

type EventOf<T> = T extends EventDef<infer D> ? Envelope<D> : never;

/**
 * `crm.activity.observed` (Ruling 19): the open pending assignment's seller doing something in the CRM
 * accepts it, with `crm_activity`; a reply or meeting moves the stage to `engaged`. The two moves use
 * distinct causes, since one cause moves an account at most once. One snapshot, only when something changed.
 */
export async function onCrmActivity(e: EventOf<typeof activityObserved>, ctx: ModuleContext): Promise<void> {
  const { accountId, actorUserId, kind } = e.data;
  const row = await lockRow(ctx, accountId);
  if (!row || row.mergedInto) return;
  let changed = false;
  const open = await openAssignment(ctx, accountId);
  if (open?.status === 'pending' && actorUserId && actorUserId === open.sellerUserId) {
    await acceptLocked(ctx, open, 'crm_activity', new Date());
    changed = true;
  }
  if (kind === 'reply' || kind === 'meeting') changed = !!(await moveStage(ctx, accountId, 'engaged', e.id)) || changed;
  if (changed) await publishReviewSnapshot(ctx, accountId);
}

const DEAL_STAGE: Record<'open' | 'won' | 'lost', StageEvent> = { open: 'opportunity', won: 'won', lost: 'lost' };

/** `crm.deal.changed`: an open deal moves the stage to `opportunity`, a won one to `won`, a lost one to `lost`. */
export async function onCrmDeal(e: EventOf<typeof dealChanged>, ctx: ModuleContext): Promise<void> {
  const { accountId, status } = e.data;
  const row = await lockRow(ctx, accountId);
  if (!row || row.mergedInto) return;
  if (await moveStage(ctx, accountId, DEAL_STAGE[status], e.id)) await publishReviewSnapshot(ctx, accountId);
}

/** Sets `flags.handoff` unless the event is for an assignment other than the account's latest or the stored state is newer; one snapshot when it changed. */
export async function setHandoffFlag(ctx: ModuleContext, accountId: string, assignmentId: string, next: HandoffFlag): Promise<void> {
  const row = await lockRow(ctx, accountId);
  if (!row || row.mergedInto) return;
  // A handoff that followed a merge can report on an assignment that isn't this account's.
  const [latest] = await ctx.tx
    .select({ id: assignment.id })
    .from(assignment)
    .where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.accountId, accountId)))
    .orderBy(desc(assignment.assignedAt), desc(assignment.id))
    .limit(1);
  if (latest?.id !== assignmentId) return;
  const current = row.flags.handoff;
  if (current && Date.parse(current.at) > Date.parse(next.at)) return;
  await ctx.tx
    .update(accountReview)
    .set({ flags: { ...row.flags, handoff: next } })
    .where(and(eq(accountReview.tenantId, ctx.tenantId), eq(accountReview.accountId, accountId)));
  await publishReviewSnapshot(ctx, accountId);
}

export const onHandoffCompleted = (e: EventOf<typeof handoffCompleted>, ctx: ModuleContext) =>
  setHandoffFlag(ctx, e.data.accountId, e.data.assignmentId, { handoffId: e.data.handoffId, state: 'in_crm', at: e.data.observedAt });

export const onHandoffFailed = (e: EventOf<typeof handoffFailed>, ctx: ModuleContext) =>
  setHandoffFlag(ctx, e.data.accountId, e.data.assignmentId, { handoffId: e.data.handoffId, state: 'failed', reason: e.data.reason, at: e.occurredAt });

export const onHandoffNeedsDecision = (e: EventOf<typeof handoffNeedsDecision>, ctx: ModuleContext) =>
  setHandoffFlag(ctx, e.data.accountId, e.data.assignmentId, {
    handoffId: e.data.handoffId,
    state: 'needs_decision',
    reason: e.data.reason,
    currentOwnerName: e.data.currentOwnerName,
    at: e.occurredAt,
  });

export const onHandoffCancelled = (e: EventOf<typeof handoffCancelled>, ctx: ModuleContext) =>
  setHandoffFlag(ctx, e.data.accountId, e.data.assignmentId, { handoffId: e.data.handoffId, state: 'cancelled', at: e.data.at });
