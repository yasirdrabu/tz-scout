import { and, eq, inArray, ne, or } from 'drizzle-orm';
import { getSummaries, type AccountSummaryView } from '@/modules/accounts';
import type { OfferCounts, OfferUsage } from '@/modules/offers';
import type { ModuleContext } from '@/platform/context';
import { offerMatch, scoreChange } from '../db/schema';

const CHUNK = 1_000;

/** The summaries of the visible accounts among `ids`, a chunk at a time (getSummaries takes at most 1,000). */
async function visible(ctx: ModuleContext, ids: string[]): Promise<Map<string, AccountSummaryView>> {
  const out = new Map<string, AccountSummaryView>();
  for (let i = 0; i < ids.length; i += CHUNK) for (const s of await getSummaries(ctx, ids.slice(i, i + CHUNK))) out.set(s.accountId, s);
  return out;
}

/** What Scoring knows about an offer's use: its matches and the score changes that name it (Rulings 12 and 14). */
export const scoringOfferUsage: OfferUsage = {
  async hasHistory(ctx, offerId) {
    const [match] = await ctx.tx
      .select({ id: offerMatch.id })
      .from(offerMatch)
      .where(and(eq(offerMatch.tenantId, ctx.tenantId), eq(offerMatch.offerId, offerId)))
      .limit(1);
    if (match) return true;
    const [change] = await ctx.tx
      .select({ id: scoreChange.id })
      .from(scoreChange)
      .where(and(eq(scoreChange.tenantId, ctx.tenantId), or(eq(scoreChange.fromOfferId, offerId), eq(scoreChange.toOfferId, offerId))))
      .limit(1);
    return !!change;
  },

  /**
   * Matched: accounts whose current match is not `not_fit`. Won: those matched accounts at stage won with the offer as
   * lead offer (the pick, else the best offer), so won never exceeds matched.
   */
  async counts(ctx, offerIds) {
    const rows = await ctx.tx
      .select({ offerId: offerMatch.offerId, accountId: offerMatch.accountId })
      .from(offerMatch)
      .where(and(eq(offerMatch.tenantId, ctx.tenantId), inArray(offerMatch.offerId, offerIds), ne(offerMatch.tier, 'not_fit')));
    const seen = await visible(ctx, [...new Set(rows.map((r) => r.accountId))]);
    const out = new Map<string, OfferCounts>(offerIds.map((id) => [id, { matched: 0, won: 0 }]));
    for (const r of rows) {
      const s = seen.get(r.accountId);
      if (!s) continue;
      const c = out.get(r.offerId)!;
      c.matched += 1;
      if (s.stage === 'won' && (s.leadOfferOverrideId ?? s.bestOfferId) === r.offerId) c.won += 1;
    }
    return out;
  },
};
