import type { ModuleContext } from '@/platform/context';
import { offerUsages, type OfferCounts } from '../contracts/ports';
import type { Offer } from './offers';

export type OfferStat = { offerId: string; practiceId: string; matched: number; won: number; winRate: number | null };

/**
 * Current, not attributed, numbers for each offer (Ruling 14): matched and won come from the module that keeps
 * matches, within the caller's data limit; the win rate is `won / matched` as a whole percent, null when nothing matched.
 */
export async function offerStats(ctx: ModuleContext, offers: Offer[]): Promise<OfferStat[]> {
  const ids = offers.map((o) => o.id);
  const counts = new Map<string, OfferCounts>();
  for (const u of offerUsages()) {
    if (!u.counts || ids.length === 0) continue;
    for (const [id, c] of await u.counts(ctx, ids)) {
      const had = counts.get(id) ?? { matched: 0, won: 0 };
      counts.set(id, { matched: had.matched + c.matched, won: had.won + c.won });
    }
  }
  return offers.map((o) => {
    const { matched, won } = counts.get(o.id) ?? { matched: 0, won: 0 };
    return { offerId: o.id, practiceId: o.practiceId, matched, won, winRate: matched === 0 ? null : Math.round((won / matched) * 100) };
  });
}
