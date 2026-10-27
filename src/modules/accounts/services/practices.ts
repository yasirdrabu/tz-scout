import { and, eq } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { accountUpdated } from '../contracts/events';
import { ScoutError } from '@/platform/errors';
import { account } from '../db/schema';
import { filterVisibleAccountIds } from './visibility';

/**
 * Sets an account's practices. A hint only adds (D25); a person may also remove. Publishes
 * `accounts.account.updated` with `changedKeys: ['practice_ids']` when something changed.
 * `publish: false` skips the event (a hint on a just-created account). Returns the practice ids now on the account.
 */
export async function setPractices(
  ctx: ModuleContext,
  accountId: string,
  practiceIds: string[],
  by: 'hint' | 'person',
  opts: { publish?: boolean } = {},
): Promise<string[]> {
  if (by === 'person' && (await filterVisibleAccountIds(ctx, [accountId])).length === 0) {
    throw new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
  }
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
  if (opts.publish !== false) await publish(ctx, accountUpdated, { accountId, changedKeys: ['practice_ids'] }, { type: 'account', id: accountId });
  return next;
}
