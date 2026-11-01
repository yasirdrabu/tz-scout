import { z } from 'zod';
import { setLeadOffer } from '@/modules/routing';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

const body = z.strictObject({ offer_id: z.string().nullable() });

/** Decision 5: the offer the account leads with (approved offers only), or null for Scout's best offer. */
export const PUT = v1Route({ permission: 'review:act', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  return setLeadOffer(ctx, id, (await parseBody<{ offerId: string | null }>(req, body)).offerId);
});
