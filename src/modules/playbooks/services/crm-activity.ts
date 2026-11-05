import { and, eq, notInArray } from 'drizzle-orm';
import type { z } from 'zod';
import { resolveAccountId } from '@/modules/accounts';
import type { activityObserved } from '@/modules/crm/contracts/events';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { stepCompleted } from '../contracts/events';
import { accountPlan, planStep } from '../db/schema';
import { checkNoReply, CLOSED, OPEN_STEP, publishChanged, recordChange, snapshot, stopPlan, type Plan } from './plans';

type Observed = z.output<typeof activityObserved.data>;

/** Rulings 13: what a reply or meeting stops, by the plan's rule. */
const STOPS: Record<string, readonly string[]> = { reply_or_meeting: ['reply', 'meeting'], meeting: ['meeting'], never: [] };
const REASON: Record<string, string> = { reply: 'They replied', meeting: 'They booked a meeting' };

/**
 * `crm.activity.observed` (Rulings 13 and 14). A reply or meeting seen since the plan was accepted marks the plan engaged and
 * stops it when its rule says so; activity logged before accept (history in the CRM) counts for nothing. A finished HubSpot
 * task marks its step done. The account's open plan only, active or paused.
 */
export async function onCrmActivity(e: { data: Observed; occurredAt: string }, ctx: ModuleContext): Promise<void> {
  const { kind } = e.data;
  if (kind !== 'reply' && kind !== 'meeting' && kind !== 'task_done') return;
  const accountId = (await resolveAccountId(ctx, e.data.accountId))?.id ?? e.data.accountId;
  const [plan] = await ctx.tx
    .select()
    .from(accountPlan)
    .where(and(eq(accountPlan.tenantId, ctx.tenantId), eq(accountPlan.accountId, accountId), notInArray(accountPlan.status, CLOSED)))
    .for('update');
  if (!plan) return;
  const at = new Date(e.data.occurredAt);

  if (kind === 'task_done') {
    if (e.data.stepId) await stepDoneInCrm(ctx, plan, e.data.stepId, at);
    return;
  }
  if (at < plan.acceptedAt) return;
  if (!plan.engagedAt) await ctx.tx.update(accountPlan).set({ engagedAt: at, updatedAt: new Date() }).where(eq(accountPlan.id, plan.id));
  if (STOPS[plan.stopWhen]?.includes(kind)) await stopPlan(ctx, plan.id, REASON[kind]!);
}

/** A step done in HubSpot: `done_by` stays null and the history says where it came from. Anything not open is left alone. */
async function stepDoneInCrm(ctx: ModuleContext, plan: Plan, stepId: string, at: Date): Promise<void> {
  const [step] = await ctx.tx
    .select()
    .from(planStep)
    .where(and(eq(planStep.tenantId, ctx.tenantId), eq(planStep.planId, plan.id), eq(planStep.id, stepId)))
    .for('update');
  if (!step || !OPEN_STEP.includes(step.status)) return;
  const [row] = await ctx.tx.update(planStep).set({ status: 'done', doneAt: at, doneBy: null }).where(eq(planStep.id, stepId)).returning();
  await ctx.tx.update(accountPlan).set({ updatedAt: new Date() }).where(eq(accountPlan.id, plan.id));
  await recordChange(ctx, plan.id, 'step_status', { from: step.status, to: 'done', source: 'crm' }, stepId);
  await publishChanged(ctx, plan, ['steps'], undefined, { steps: [snapshot(row!)] });
  await publish(
    ctx,
    stepCompleted,
    { planId: plan.id, stepId, accountId: plan.accountId, channel: row!.channel as 'email', doneBy: null, doneAt: at.toISOString() },
    { type: 'account', id: plan.accountId },
  );
  await audit(ctx, { action: 'playbooks.plan_step.updated', subject: { type: 'account_plan', id: plan.id }, after: { stepId, changed: ['step_status'] } });
  await checkNoReply(ctx, plan.id);
}
