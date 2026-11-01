import { and, eq, or } from 'drizzle-orm';
import type { OfferUsage } from '@/modules/offers';
import { accountReview, leadOfferChange } from '../db/schema';

/** Routing's part of an offer's history (Ruling 12): a lead offer someone picked, now or before. */
export const routingOfferUsage: OfferUsage = {
  async hasHistory(ctx, offerId) {
    const [override] = await ctx.tx
      .select({ id: accountReview.accountId })
      .from(accountReview)
      .where(and(eq(accountReview.tenantId, ctx.tenantId), eq(accountReview.leadOfferOverrideId, offerId)))
      .limit(1);
    if (override) return true;
    const [change] = await ctx.tx
      .select({ id: leadOfferChange.id })
      .from(leadOfferChange)
      .where(and(eq(leadOfferChange.tenantId, ctx.tenantId), or(eq(leadOfferChange.fromOfferId, offerId), eq(leadOfferChange.toOfferId, offerId))))
      .limit(1);
    return !!change;
  },
};
