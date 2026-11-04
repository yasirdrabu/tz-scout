import { sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { enrichmentOpen } from '../db/schema';

/** A flagged or approved request is open. Seen again, or after it closed, it changes nothing. */
export async function openEnrichment(ctx: ModuleContext, r: { requestId: string; accountId: string; requestedByLabel: string }): Promise<void> {
  await ctx.tx
    .insert(enrichmentOpen)
    .values({ tenantId: ctx.tenantId, accountId: r.accountId, requestId: r.requestId, requestedByLabel: r.requestedByLabel })
    .onConflictDoNothing();
}

/** A request that ended is closed. If its open event hasn't run yet, a closed row is left so that event can't open it. */
export async function closeEnrichment(ctx: ModuleContext, r: { requestId: string; accountId: string }): Promise<void> {
  await ctx.tx
    .insert(enrichmentOpen)
    .values({ tenantId: ctx.tenantId, accountId: r.accountId, requestId: r.requestId, requestedByLabel: '', closedAt: new Date() })
    .onConflictDoUpdate({ target: [enrichmentOpen.tenantId, enrichmentOpen.requestId], set: { closedAt: sql`coalesce(${enrichmentOpen.closedAt}, now())` } });
}
