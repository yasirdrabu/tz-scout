import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { listAccountIds } from '@/modules/accounts';
import { accountIdsForSource } from '@/modules/intake';
import { listApprovedOffers } from '@/modules/offers';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { enqueueJob } from '@/platform/events/outbox';
import { log } from '@/platform/log';
import { ageingJob, rescoreAccountsJob, rescorePageJob, type RescoreFilter } from '../contracts/jobs';
import type { ScoreCause } from '../contracts/types';
import { accountScore, offerMatch } from '../db/schema';
import { getProfile } from './profile';
import { scoreAccount } from './score';

/** Accounts per message (Ruling 10): a smaller page than the spec's 500 shortens how long account locks are held. */
export const RESCORE_PAGE_SIZE = 200;
const DAY_MS = 86_400_000;
const AGEING_MIN_AGE_MS = 20 * 3_600_000;

/**
 * Scores each account in its own savepoint, with the profile and approved offers loaded once. An account that is
 * gone is skipped. Any other failure is logged and that account is queued again on its own, so one bad account
 * does not undo the other scores; a lone account that fails fails the message, and the normal retries apply.
 */
export async function rescoreAccounts(ctx: ModuleContext, accountIds: string[], cause: ScoreCause): Promise<void> {
  const profile = await getProfile(ctx);
  const offers = await listApprovedOffers(ctx);
  const failed: string[] = [];
  for (const id of accountIds) {
    try {
      await ctx.tx.transaction((tx) => scoreAccount({ ...ctx, tx }, id, cause, undefined, { profile, offers }));
    } catch (e) {
      if (e instanceof ScoutError && e.status === 404) continue;
      if (accountIds.length === 1) throw e;
      log.error({ accountId: id, err: (e as Error).message }, 'rescore: account failed, queued again alone');
      failed.push(id);
    }
  }
  for (const id of failed) await enqueueJob(ctx, rescoreAccountsJob, { accountIds: [id], cause });
}

/** One page of account ids for `filter`, in id order. */
async function pageIds(ctx: ModuleContext, filter: RescoreFilter, afterId: string | undefined) {
  const cursor = afterId ? { afterId } : {};
  if (filter.sourceId) return accountIdsForSource(ctx, filter.sourceId, { ...cursor, limit: RESCORE_PAGE_SIZE });
  if (filter.offerId) {
    const rows = await ctx.tx
      .select({ id: offerMatch.accountId })
      .from(offerMatch)
      .where(and(eq(offerMatch.tenantId, ctx.tenantId), eq(offerMatch.offerId, filter.offerId), afterId ? gt(offerMatch.accountId, afterId) : undefined))
      .orderBy(asc(offerMatch.accountId))
      .limit(RESCORE_PAGE_SIZE + 1);
    const ids = rows.slice(0, RESCORE_PAGE_SIZE).map((r) => r.id);
    return { ids, nextAfterId: rows.length > RESCORE_PAGE_SIZE ? ids[ids.length - 1]! : null };
  }
  return listAccountIds(ctx, {
    ...cursor,
    ...(filter.practiceId ? { practiceIds: [filter.practiceId] } : {}),
    ...(filter.includeNoPractice ? { includeNoPractice: true } : {}),
    limit: RESCORE_PAGE_SIZE,
  });
}

/** Queues rescore.accounts for one page of `filter` and, when there is more, the next page. */
export async function rescorePage(ctx: ModuleContext, filter: RescoreFilter, cause: ScoreCause, afterId?: string): Promise<void> {
  const page = await pageIds(ctx, filter, afterId);
  if (page.ids.length > 0) await enqueueJob(ctx, rescoreAccountsJob, { accountIds: page.ids, cause });
  if (page.nextAfterId) await enqueueJob(ctx, rescorePageJob, { filter, cause, afterId: page.nextAfterId });
}

/** Starts a rescore of every account matching `filter`. Returns the job id. */
export const startRescore = (ctx: ModuleContext, filter: RescoreFilter, cause: ScoreCause): Promise<string> =>
  enqueueJob(ctx, rescorePageJob, { filter, cause });

/** Rescores the whole tenant, or one practice or source (SCO-E5-S4-AC1). The route checks `scoring:manage`. */
export function requestRescore(ctx: ModuleContext, filter: { practiceId?: string; sourceId?: string } = {}): Promise<string> {
  if (filter.practiceId && filter.sourceId) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Choose a practice or a source, not both.' });
  }
  return startRescore(ctx, filter, 'manual_rescore');
}

/**
 * One page of the nightly job: accounts with a signal younger than a year whose score is missing or over 20 hours old
 * go to rescore.accounts, and the next page follows.
 */
export async function ageingPage(ctx: ModuleContext, afterId: string | undefined, now: Date = new Date()): Promise<void> {
  const page = await listAccountIds(ctx, {
    hasSignalSince: new Date(now.getTime() - 365 * DAY_MS),
    ...(afterId ? { afterId } : {}),
    limit: RESCORE_PAGE_SIZE,
  });
  if (page.ids.length > 0) {
    const scored = await ctx.tx
      .select({ id: accountScore.accountId, computedAt: accountScore.computedAt })
      .from(accountScore)
      .where(and(eq(accountScore.tenantId, ctx.tenantId), inArray(accountScore.accountId, page.ids)));
    const recent = new Set(scored.filter((s) => now.getTime() - s.computedAt.getTime() <= AGEING_MIN_AGE_MS).map((s) => s.id));
    const due = page.ids.filter((id) => !recent.has(id));
    if (due.length > 0) await enqueueJob(ctx, rescoreAccountsJob, { accountIds: due, cause: 'ageing' });
  }
  if (page.nextAfterId) await enqueueJob(ctx, ageingJob, { afterId: page.nextAfterId });
}
