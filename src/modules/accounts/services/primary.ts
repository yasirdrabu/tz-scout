import { and, eq, isNull } from 'drizzle-orm';
import { getOffer } from '@/modules/offers';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { accountSummary, person } from '../db/schema';
import { pickPrimary } from '../domain/primary';

/** The target titles of the account's best offer, or none when it has no best offer or the offer is gone. */
async function bestOfferTitles(ctx: ModuleContext, accountId: string): Promise<string[]> {
  const [row] = await ctx.tx
    .select({ offerId: accountSummary.bestOfferId })
    .from(accountSummary)
    .where(and(eq(accountSummary.tenantId, ctx.tenantId), eq(accountSummary.accountId, accountId)));
  if (!row?.offerId) return [];
  try {
    return (await getOffer(ctx, row.offerId)).targetTitles;
  } catch (e) {
    if (e instanceof ScoutError && e.status === 404) return [];
    throw e;
  }
}

/**
 * Marks who to approach first: the pinned person if there is one, else the best by target-title match,
 * seniority and verified email. Target titles are the best offer's (`account_summary.best_offer_id`), so every
 * caller gets the same answer. The caller holds the account lock.
 */
export async function repickPrimary(ctx: ModuleContext, accountId: string): Promise<void> {
  const people = await ctx.tx
    .select()
    .from(person)
    .where(and(eq(person.tenantId, ctx.tenantId), eq(person.accountId, accountId), isNull(person.archivedAt)));
  const primaryId = pickPrimary(
    people.map((p) => ({ id: p.id, title: p.title, seniority: p.seniority, emailStatus: p.emailStatus, pinnedPrimary: !!p.primaryPinnedAt })),
    await bestOfferTitles(ctx, accountId),
  );
  for (const p of people) {
    const next = p.id === primaryId;
    if (p.isPrimary !== next) {
      await ctx.tx
        .update(person)
        .set({ isPrimary: next, updatedAt: new Date() })
        .where(and(eq(person.tenantId, ctx.tenantId), eq(person.id, p.id)));
    }
  }
}
