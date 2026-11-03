import { and, eq, lte } from 'drizzle-orm';
import { recordSourceFeedback } from '@/modules/intake';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { requestCancelled } from '../contracts/events';
import { request } from '../db/schema';

/** A request flagged this long without an answer is cancelled (Ruling 7). */
export const EXPIRE_AFTER_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * Cancels the requests flagged for 14 days or more as of `now`, with `decline_reason: 'expired'`, publishes
 * `enrichment.request.cancelled` and tells the requesting source (`enrichment_expired`, Ruling 10). Returns how many.
 */
export async function expireFlagged(ctx: ModuleContext, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - EXPIRE_AFTER_DAYS * DAY_MS);
  const stale = await ctx.tx
    .select()
    .from(request)
    .where(and(eq(request.tenantId, ctx.tenantId), eq(request.status, 'flagged'), lte(request.createdAt, cutoff)))
    .orderBy(request.id)
    .for('update');
  for (const r of stale) {
    await ctx.tx.update(request).set({ status: 'cancelled', declineReason: 'expired', updatedAt: now }).where(eq(request.id, r.id));
    const event = await publish(ctx, requestCancelled, { requestId: r.id, accountId: r.accountId!, reason: 'expired' }, { type: 'enrichment_request', id: r.id });
    if (r.requestingSourceId && r.accountId) {
      await recordSourceFeedback(ctx, { sourceId: r.requestingSourceId, accountId: r.accountId, kind: 'enrichment_expired', note: null, causeEventId: event.id });
    }
  }
  return stale.length;
}
