import { and, eq, inArray } from 'drizzle-orm';
import { listAccountIds } from '@/modules/accounts';
import { initialReviewStatusKeys } from '@/modules/intake';
import type { ModuleContext } from '@/platform/context';
import { accountReview } from '../db/schema';
import { ensureReview, loadStatuses } from './review';
import { publishReviewSnapshot } from './snapshot';

const PAGE = 200;

/**
 * R1b backfill: gives every active account with a resolved arrival and no review row one, as the arrival consumer would have
 * (insert or nothing, then lock), at the status its first resolved arrival named, else `unvetted`, and
 * publishes one snapshot for each so the account reaches the queue. Background context only. Returns how
 * many reviews it created.
 */
export async function backfillReviews(ctx: ModuleContext): Promise<number> {
  const active = new Set((await loadStatuses(ctx)).filter((s) => !s.archivedAt).map((s) => s.key));
  let created = 0;
  let afterId: string | undefined;
  do {
    const page = await listAccountIds(ctx, { limit: PAGE, ...(afterId ? { afterId } : {}) });
    const have = new Set(
      page.ids.length
        ? (await ctx.tx.select({ id: accountReview.accountId }).from(accountReview).where(and(eq(accountReview.tenantId, ctx.tenantId), inArray(accountReview.accountId, page.ids)))).map((r) => r.id)
        : [],
    );
    const missing = page.ids.filter((id) => !have.has(id));
    const keys = await initialReviewStatusKeys(ctx, missing);
    for (const id of missing) {
      const key = keys.get(id);
      if (!key) continue; // no resolved arrival: the live flow never gives such an account a review
      const made = await ensureReview(ctx, id, active.has(key) ? key : 'unvetted');
      if (!made.created) continue;
      await publishReviewSnapshot(ctx, id);
      created++;
    }
    afterId = page.nextAfterId ?? undefined;
  } while (afterId);
  return created;
}
