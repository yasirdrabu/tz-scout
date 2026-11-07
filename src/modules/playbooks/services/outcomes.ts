import { and, desc, eq, lte } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { outcomeRecorded } from '../contracts/events';
import { accountPlan, outcome, planStep } from '../db/schema';
import { creditedSteps } from '../domain/credit';

export const OUTCOME_KINDS = ['reply', 'meeting', 'opportunity', 'won', 'lost', 'no_response'] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export type OutcomeInput = {
  accountId: string;
  kind: OutcomeKind;
  /** The CRM activity or deal (`{system}:{externalId}`), or the plan id for no_response. Unique per kind. */
  ref: string;
  occurredAt: Date;
  source: 'crm' | 'playbooks';
  amountCents?: number | null;
  /** The plan it belongs to; without it, the account's plan with the latest accepted_at at or before occurredAt. */
  planId?: string;
};

/**
 * Records an outcome on its plan (Ruling 1) and credits the plan's steps done in the 14 days before it. Publishes
 * `playbooks.outcome.recorded` when the row is new. Null when there is no plan, the ref is already recorded for the
 * kind, or the outcome is a second opportunity on the plan (Ruling 3).
 */
export async function recordOutcome(ctx: ModuleContext, input: OutcomeInput): Promise<{ id: string } | null> {
  const [plan] = await ctx.tx
    .select({ id: accountPlan.id, templateId: accountPlan.templateId })
    .from(accountPlan)
    .where(
      and(
        eq(accountPlan.tenantId, ctx.tenantId),
        input.planId ? eq(accountPlan.id, input.planId) : and(eq(accountPlan.accountId, input.accountId), lte(accountPlan.acceptedAt, input.occurredAt)),
      ),
    )
    .orderBy(desc(accountPlan.acceptedAt), desc(accountPlan.id))
    .limit(1)
    .for('update');
  if (!plan) return null;

  if (input.kind === 'opportunity') {
    const [had] = await ctx.tx
      .select({ id: outcome.id })
      .from(outcome)
      .where(and(eq(outcome.tenantId, ctx.tenantId), eq(outcome.planId, plan.id), eq(outcome.kind, 'opportunity')))
      .limit(1);
    if (had) return null;
  }

  const steps = await ctx.tx
    .select({ id: planStep.id, channel: planStep.channel, status: planStep.status, doneAt: planStep.doneAt })
    .from(planStep)
    .where(and(eq(planStep.tenantId, ctx.tenantId), eq(planStep.planId, plan.id)));
  const credited = creditedSteps(steps, input.occurredAt);
  const amountCents = input.amountCents ?? null;

  const [row] = await ctx.tx
    .insert(outcome)
    .values({
      id: newId('out'),
      tenantId: ctx.tenantId,
      accountId: input.accountId,
      planId: plan.id,
      templateId: plan.templateId,
      kind: input.kind,
      ref: input.ref,
      source: input.source,
      occurredAt: input.occurredAt,
      amountCents,
      creditedStepIds: credited.map((s) => s.stepId),
    })
    .onConflictDoNothing({ target: [outcome.tenantId, outcome.kind, outcome.ref] })
    .returning({ id: outcome.id });
  if (!row) return null;

  await publish(
    ctx,
    outcomeRecorded,
    {
      outcomeId: row.id,
      accountId: input.accountId,
      planId: plan.id,
      templateId: plan.templateId,
      kind: input.kind,
      occurredAt: input.occurredAt.toISOString(),
      source: input.source,
      amountCents,
      creditedStepIds: credited.map((s) => s.stepId),
      creditedSteps: credited.map((s) => ({ stepId: s.stepId, channel: s.channel as 'email' })),
    },
    { type: 'account', id: input.accountId },
  );
  return { id: row.id };
}
