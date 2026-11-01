import type { ModuleContext } from '@/platform/context';

// Ports Offers defines and higher modules implement (scoring and routing). The composition root
// (src/entry/compose.ts) registers the implementations; until then none apply.

/** Per offer: accounts the caller can see whose current match is not `not_fit` (Nurture counts), and those won with it as lead offer. */
export type OfferCounts = { matched: number; won: number };

/** What other modules know about how an offer was used (Ruling 12, Ruling 14). */
export interface OfferUsage {
  /** True when this module keeps anything that names the offer: a match, a score change, a lead offer. */
  hasHistory(ctx: ModuleContext, offerId: string): Promise<boolean>;
  /** Current counts within the caller's data limit, for the given offers. Only the module that keeps matches answers. */
  counts?(ctx: ModuleContext, offerIds: string[]): Promise<Map<string, OfferCounts>>;
}

let usages: OfferUsage[] = [];

/** Replaces the registered implementations; call with none to clear (tests). */
export function registerOfferUsage(...u: OfferUsage[]): void {
  usages = u;
}

export const offerUsages = (): readonly OfferUsage[] => usages;
