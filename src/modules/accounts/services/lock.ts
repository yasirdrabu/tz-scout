import { sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';

/**
 * The Account aggregate's consistency boundary: a transaction-scoped advisory lock per account.
 * Every write path takes it before reading what it will change. It is the innermost lock
 * (cap lock, then resolve lock, then account lock).
 */
export async function lockAccount(ctx: ModuleContext, accountId: string): Promise<void> {
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ctx.tenantId} || ':acc:' || ${accountId}))`);
}

/** Locks several accounts, lowest id first, so two callers never wait on each other in a cycle. */
export async function lockAccounts(ctx: ModuleContext, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await lockAccount(ctx, id);
}
