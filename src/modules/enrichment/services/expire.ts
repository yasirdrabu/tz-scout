import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import { recordSourceFeedback } from '@/modules/intake';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { requestCancelled, requestFailed } from '../contracts/events';
import { request } from '../db/schema';

/** A request flagged this long without an answer is cancelled (Ruling 7). */
export const EXPIRE_AFTER_DAYS = 14;
/** A request approved or running this long unchanged, and not waiting on a limit, has stopped (review I1). */
export const STUCK_AFTER_HOURS = 24;
export const STOPPED = 'This enrichment stopped without finishing. Try again.';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

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
    const event = await publish(ctx, requestCancelled, { requestId: r.id, accountId: r.accountId, reason: 'expired' }, { type: 'enrichment_request', id: r.id });
    if (r.requestingSourceId) {
      await recordSourceFeedback(ctx, { sourceId: r.requestingSourceId, accountId: r.accountId, kind: 'enrichment_expired', note: null, causeEventId: event.id });
    }
  }
  return stale.length;
}

/**
 * Fails the requests `approved` or `running` unchanged for 24 hours or more as of `now` and not waiting on a limit
 * (their job dead-lettered or was lost), and publishes `enrichment.request.failed`: the queue chip clears, the notice
 * stops polling, and a new request of the kind is no longer joined to them. A wait on a limit can last until the
 * limit resets, so it is left alone. Returns how many.
 */
export async function failStuck(ctx: ModuleContext, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_HOURS * HOUR_MS);
  const stuck = await ctx.tx
    .select()
    .from(request)
    .where(
      and(
        eq(request.tenantId, ctx.tenantId),
        inArray(request.status, ['approved', 'running']),
        isNull(request.waitingReason),
        lte(request.updatedAt, cutoff),
      ),
    )
    .orderBy(request.id)
    .for('update');
  const error = { kind: 'unknown' as const, message: STOPPED };
  for (const r of stuck) {
    await ctx.tx.update(request).set({ status: 'failed', error, finishedAt: now, updatedAt: now }).where(eq(request.id, r.id));
    await publish(
      ctx,
      requestFailed,
      { requestId: r.id, accountId: r.accountId, providerKey: r.providerKey, errorKind: error.kind, message: STOPPED, creditsUsed: 0, costCents: 0 },
      { type: 'enrichment_request', id: r.id },
    );
  }
  return stuck.length;
}
