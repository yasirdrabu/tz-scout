import { and, eq, gte, isNotNull, lte } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { accountPlan, planStep } from '../db/schema';

/** Plan steps with an owner due between two days (tenant-local dates, inclusive), for the analytics overview. Skipped steps are included. Background context only. */
export async function listStepFacts(
  ctx: ModuleContext,
  days: { fromDay: string; toDay: string },
): Promise<{ accountId: string; ownerUserId: string; dueDate: string; doneAt: Date | null; status: string }[]> {
  const rows = await ctx.tx
    .select({ accountId: accountPlan.accountId, ownerUserId: planStep.ownerUserId, dueDate: planStep.dueDate, doneAt: planStep.doneAt, status: planStep.status })
    .from(planStep)
    .innerJoin(accountPlan, eq(accountPlan.id, planStep.planId))
    .where(and(eq(planStep.tenantId, ctx.tenantId), isNotNull(planStep.ownerUserId), gte(planStep.dueDate, days.fromDay), lte(planStep.dueDate, days.toDay)));
  return rows.flatMap((r) => (r.ownerUserId ? [{ ...r, ownerUserId: r.ownerUserId }] : []));
}
