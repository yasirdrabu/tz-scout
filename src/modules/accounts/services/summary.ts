import { and, eq, isNull, lt, max, or, sql } from 'drizzle-orm';
import type { ReviewSnapshot } from '@/modules/routing/contracts/types';
import type { ModuleContext } from '@/platform/context';
import { account, accountSummary, signal } from '../db/schema';
import { lockAccount } from './lock';
import { resolveAccountId } from './match';
import { repickPrimary } from './primary';

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

export type ScoreSnapshot = {
  priority: number;
  fit: number;
  intent: number;
  tier: string;
  bestOfferId: string | null;
  practiceId: string | null;
  version: number;
};

/**
 * Overwrites the summary's score columns from a `scoring.account.scored` snapshot when its version is newer
 * than the stored one (the condition is in the update, so a stale or replayed event writes nothing), then
 * re-picks the primary contact for the new best offer. An id that was merged away or is unknown is ignored:
 * the survivor gets its own scored event.
 */
export async function applyScore(ctx: ModuleContext, accountId: string, s: ScoreSnapshot): Promise<void> {
  await lockAccount(ctx, accountId);
  // Resolved under the lock: a merge in flight holds it, so the answer is current.
  const resolved = await resolveAccountId(ctx, accountId);
  if (!resolved || resolved.mergedInto) return;
  // The summary row is written with the account (writeSummary), so a missing row makes the update a no-op.
  const written = await ctx.tx
    .update(accountSummary)
    .set({
      priority: s.priority,
      fit: s.fit,
      intent: s.intent,
      tier: s.tier,
      bestOfferId: s.bestOfferId,
      practiceId: s.practiceId,
      scoreVersion: s.version,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(accountSummary.tenantId, ctx.tenantId),
        eq(accountSummary.accountId, accountId),
        or(isNull(accountSummary.scoreVersion), lt(accountSummary.scoreVersion, s.version)),
      ),
    )
    .returning({ accountId: accountSummary.accountId });
  if (written.length > 0) await repickPrimary(ctx, accountId);
}

/**
 * Overwrites the summary's review columns from a `routing.review.changed` snapshot when its version is newer
 * than the stored one (the condition is in the update, so a stale or replayed event writes nothing). An id
 * that was merged away or is unknown is ignored: routing publishes a snapshot for the survivor.
 */
export async function applyReview(ctx: ModuleContext, accountId: string, s: ReviewSnapshot, version: number): Promise<void> {
  await lockAccount(ctx, accountId);
  const resolved = await resolveAccountId(ctx, accountId);
  if (!resolved || resolved.mergedInto) return;
  await ctx.tx
    .update(accountSummary)
    .set({
      reviewStatusKey: s.reviewStatusKey,
      ownerUserId: s.ownerUserId,
      ownerHistoryUserIds: s.ownerHistoryUserIds,
      hasOpenAssignment: s.hasOpenAssignment,
      stage: s.stage,
      reviewFlags: s.reviewFlags,
      reviewVersion: version,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(accountSummary.tenantId, ctx.tenantId),
        eq(accountSummary.accountId, accountId),
        or(isNull(accountSummary.reviewVersion), lt(accountSummary.reviewVersion, version)),
      ),
    );
}
