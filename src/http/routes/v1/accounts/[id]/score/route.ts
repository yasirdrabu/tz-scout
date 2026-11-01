import { explainScore } from '@/modules/scoring';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/** SCO-E4-S2: the explanation with would_raise and a summary. A hidden, missing or unscored account is a 404, never a 403. */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const offerId = new URL(req.url).searchParams.get('offer_id') || undefined;
  const explained = await explainScore(ctx, id, offerId ? { offerId } : {});
  if (!explained) throw notFound();
  return explained;
});
