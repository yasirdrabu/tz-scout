import { getSummaries } from '@/modules/accounts';
import { listOffers } from '@/modules/offers';
import type { ModuleContext } from '@/platform/context';

/**
 * The offer each account leads with, by name, for CRM's weekly batch messages: the lead offer someone picked, else
 * Scout's best offer. Two reads per call (the summaries and the offers), no brief and no package. An account that is
 * missing, hidden or has no offer maps to null.
 */
export async function bestOfferNames(ctx: ModuleContext, accountIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>(accountIds.map((id) => [id, null]));
  if (accountIds.length === 0) return out;
  const summaries = await getSummaries(ctx, accountIds);
  const names = new Map((await listOffers(ctx)).map((o) => [o.id, o.name]));
  for (const s of summaries) {
    const offerId = s.leadOfferOverrideId ?? s.bestOfferId;
    out.set(s.accountId, offerId ? (names.get(offerId) ?? null) : null);
  }
  return out;
}
