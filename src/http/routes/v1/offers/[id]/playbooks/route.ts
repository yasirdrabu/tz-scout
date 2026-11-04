import { getOffer } from '@/modules/offers';
import { offerPlaybooks } from '@/modules/playbooks';
import { can } from '@/modules/tenancy';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

// GET /api/v1/offers/{id}/playbooks: one entry for each of act_now, good_fit and watch. Like the offer itself, a draft is a 404 without `offers:manage`.
export const GET = v1Route({ permission: 'offers:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'offers');
  if (action) throw notFound();
  const offer = await getOffer(ctx, id);
  if (offer.status !== 'approved' && !can(principal, 'offers:manage')) throw notFound();
  return { data: await offerPlaybooks(ctx, id) };
});
