// The account's lead offer (SCO-E3-S2).

import { TIERS, type Match } from '../contracts/types';

/** Highest total, then better tier, then higher fit, then the offer approved first. `approvedOrder` lists offer ids, earliest approved first. */
export function bestOffer(matches: Match[], approvedOrder: string[]): Match | null {
  const approvedRank = (offerId: string) => {
    const i = approvedOrder.indexOf(offerId);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sorted = [...matches].sort(
    (a, b) =>
      b.total - a.total ||
      TIERS.indexOf(b.tier) - TIERS.indexOf(a.tier) ||
      b.fit - a.fit ||
      approvedRank(a.offerId) - approvedRank(b.offerId),
  );
  return sorted[0] ?? null;
}
