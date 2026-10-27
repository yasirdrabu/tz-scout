import { and, eq, isNull, max, sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { account, accountSummary, signal } from '../db/schema';

/**
 * Brings the account's search row up to date: `practice_ids`, `last_signal_at` and the union of
 * `source_ids`. Scoring, review and CRM columns are written by later plans.
 */
export async function writeSummary(ctx: ModuleContext, accountId: string, opts: { addSourceIds?: string[] } = {}): Promise<void> {
  const [acc] = await ctx.tx
    .select({ practiceIds: account.practiceIds })
    .from(account)
    .where(and(eq(account.tenantId, ctx.tenantId), eq(account.id, accountId)));
  if (!acc) return;
  const [last] = await ctx.tx
    .select({ at: max(signal.occurredAt) })
    .from(signal)
    .where(and(eq(signal.tenantId, ctx.tenantId), eq(signal.accountId, accountId), isNull(signal.archivedAt)));
  const sourceIds = [...new Set(opts.addSourceIds ?? [])].sort();
  await ctx.tx
    .insert(accountSummary)
    .values({ tenantId: ctx.tenantId, accountId, practiceIds: acc.practiceIds, sourceIds, lastSignalAt: last?.at ?? null })
    .onConflictDoUpdate({
      target: accountSummary.accountId,
      set: {
        practiceIds: sql`excluded.practice_ids`,
        lastSignalAt: sql`excluded.last_signal_at`,
        sourceIds: sql`array(select distinct s from unnest(account_summary.source_ids || excluded.source_ids) as s order by s)`,
        updatedAt: new Date(),
      },
    });
}
