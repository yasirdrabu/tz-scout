import { sql } from 'drizzle-orm';
import { tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { nextTenantDay, tenantDayStart } from '../domain/day';
import { loadSource } from './sources';

export type CapCheck = { allowed: boolean; remaining: number; resetsAt: Date };

/**
 * The source's daily arrival cap (Ruling 1), counted per closest source over the tenant's local day.
 * Takes the per-source cap lock, held until the transaction ends, so count-then-insert is exact
 * across concurrent requests. Take it before any resolve or account lock.
 *
 * Counted: arrivals stored to be resolved. Not counted: items rejected when they were sent (invalid,
 * over the cap or repeated in their batch), and a person's file imports, which are not capped.
 */
export async function checkArrivalCap(ctx: ModuleContext, sourceId: string, now = new Date()): Promise<CapCheck> {
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ctx.tenantId} || ':cap:' || ${sourceId}))`);
  const timezone = await tenantTimezone(ctx);
  const resetsAt = nextTenantDay(now, timezone);
  const src = await loadSource(ctx, sourceId);
  const cap = src?.dailyArrivalCap ?? 0;
  const [row] = (await ctx.tx.execute(sql`
    select count(*)::int as n from intake.arrival
    where tenant_id = ${ctx.tenantId} and closest_source_id = ${sourceId}
      and received_at >= ${tenantDayStart(now, timezone).toISOString()} and received_at < ${resetsAt.toISOString()}
      and coalesce(reject_reason, '') not in ('invalid', 'daily_cap_reached', 'duplicate_in_batch')
      ${src?.kind === 'person' ? sql`and channel <> 'file'` : sql``}
  `)) as unknown as { n: number }[];
  const remaining = Math.max(0, cap - row!.n);
  return { allowed: remaining > 0, remaining, resetsAt };
}

/** Ruling 1: a person's own file imports are not capped (the 10,000-row file limit bounds them). */
export const isCapped = (channel: string, closestKind: string): boolean => !(channel === 'file' && closestKind === 'person');
