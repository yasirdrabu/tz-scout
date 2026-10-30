import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { accountExclusionChanged } from '../contracts/events';
import type { CrmStatus } from '../contracts/types';
import { account, exclusionList, exclusionRule, fact } from '../db/schema';
import { evaluateExclusions } from '../domain/exclusions';

export type Exclusion = { key: string; label: string; override: boolean };

/**
 * Re-evaluates the exclusion rules (ACC-E7) and writes `excluded_reason_key`. Publishes
 * `accounts.account.exclusion_changed` when the result changes. The caller holds the account lock.
 */
export async function applyExclusion(ctx: ModuleContext, accountId: string, opts: { arrivalId?: string } = {}): Promise<Exclusion | null> {
  const [acc] = await ctx.tx.select().from(account).where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, accountId)));
  if (!acc) return null;
  const rules = await ctx.tx.select().from(exclusionRule).where(eq(exclusionRule.tenantId, ctx.tenantId));
  const lists = await ctx.tx.select().from(exclusionList).where(eq(exclusionList.tenantId, ctx.tenantId));
  const [parent] = await ctx.tx
    .select({ value: fact.value })
    .from(fact)
    .where(
      and(
        eq(fact.tenantId, ctx.tenantId),
        eq(fact.accountId, accountId),
        isNull(fact.personId),
        eq(fact.key, 'parent_name'),
        eq(fact.status, 'current'),
      ),
    );

  const key = evaluateExclusions(
    {
      industryKey: acc.industryKey,
      description: acc.description,
      keywords: acc.keywords,
      name: acc.name,
      parentDomain: acc.parentDomain,
      parentName: typeof parent?.value === 'string' ? parent.value : null,
      domain: acc.domain,
      crmStatus: acc.crmStatus as CrmStatus,
    },
    rules,
    lists,
  );

  if (key !== acc.excludedReasonKey) {
    await ctx.tx
      .update(account)
      .set({ excludedReasonKey: key, updatedAt: new Date() })
      .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, accountId)));
    await publish(
      ctx,
      accountExclusionChanged,
      { accountId, ...(key ? { excludedReasonKey: key } : {}), override: acc.excludedOverride, ...(opts.arrivalId ? { arrivalId: opts.arrivalId } : {}) },
      { type: 'account', id: accountId },
    );
  }
  if (!key) return null;
  return { key, label: rules.find((r) => r.key === key)?.label ?? key, override: acc.excludedOverride };
}

/**
 * Sets `crm_status` from a CRM event when `observedAt` is newer than the stored `crm_status_at` (Ruling 12), then
 * re-evaluates exclusions as an edit does. The caller holds the account lock. Returns whether anything changed.
 */
export async function applyCrmStatus(ctx: ModuleContext, accountId: string, status: CrmStatus, observedAt: Date): Promise<boolean> {
  const written = await ctx.tx
    .update(account)
    .set({ crmStatus: status, crmStatusAt: observedAt, updatedAt: new Date() })
    .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, accountId), or(isNull(account.crmStatusAt), lt(account.crmStatusAt, observedAt))))
    .returning({ id: account.id });
  if (written.length === 0) return false;
  await applyExclusion(ctx, accountId);
  return true;
}
