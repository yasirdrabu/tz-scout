import { and, eq } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { accountUpdated } from '../contracts/events';
import { account } from '../db/schema';

/**
 * Sets an account's practices. A hint only adds (D25); a person may also remove. Publishes
 * `accounts.account.updated` with `changedKeys: ['practice_ids']` when something changed.
 * Returns the practice ids now on the account.
 */
export async function setPractices(
  ctx: ModuleContext,
  accountId: string,
  practiceIds: string[],
  by: 'hint' | 'person',
): Promise<string[]> {
  const [acc] = await ctx.tx
    .select({ practiceIds: account.practiceIds })
    .from(account)
    .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, accountId)));
  if (!acc) return [];
  const next = by === 'hint' ? [...new Set([...acc.practiceIds, ...practiceIds])] : [...new Set(practiceIds)];
  const changed = next.length !== acc.practiceIds.length || next.some((id) => !acc.practiceIds.includes(id));
  if (!changed) return acc.practiceIds;
  await ctx.tx
    .update(account)
    .set({ practiceIds: next, updatedAt: new Date() })
    .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, accountId)));
  await publish(ctx, accountUpdated, { accountId, changedKeys: ['practice_ids'] }, { type: 'account', id: accountId });
  return next;
}
