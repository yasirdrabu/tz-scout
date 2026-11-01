import { listOffers, offerStats } from '@/modules/offers';
import { can } from '@/modules/tenancy';
import { v1Route } from '../../_lib/v1-route';

/**
 * Ruling 14: matched, won and the win rate per offer, over the accounts the caller can see. Current numbers, not
 * attributed. Without `offers:manage` only approved offers are listed, as on `GET /offers`.
 */
export const GET = v1Route({ permission: 'offers:read' }, async (req, principal, ctx) => {
  const practiceId = new URL(req.url).searchParams.get('practice_id') || undefined;
  const offers = await listOffers(ctx, { practiceId, status: can(principal, 'offers:manage') ? undefined : 'approved' });
  return { data: await offerStats(ctx, offers) };
});
