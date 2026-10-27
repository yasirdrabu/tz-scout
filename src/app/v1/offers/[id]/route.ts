import { approveOffer, archiveOffer, getOffer, listCaseStudies, updateOffer, type OfferPatch } from '@/modules/offers';
import { can } from '@/modules/tenancy';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';
import { patchOfferBody } from '../schemas';

export const dynamic = 'force-dynamic';

// People without `offers:manage` can read approved offers only; a draft is a 404 to them.
export const GET = v1Route({ permission: 'offers:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'offers');
  if (action) throw notFound();
  const offer = await getOffer(ctx, id);
  if (offer.status !== 'approved' && !can(principal, 'offers:manage')) throw notFound();
  const caseStudies = await listCaseStudies(ctx, { offerId: id, buyerVisibleOnly: principal.kind !== 'user' });
  return { ...offer, caseStudies };
});

export const PATCH = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'offers');
  if (action) throw notFound();
  const { offer, warning } = await updateOffer(ctx, id, await parseBody<OfferPatch>(req, patchOfferBody));
  return warning ? { ...offer, warning } : offer;
});

// POST /v1/offers/{id}:approve and /v1/offers/{id}:archive
export const POST = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'offers');
  if (action === 'approve') return approveOffer(ctx, id);
  if (action === 'archive') return archiveOffer(ctx, id);
  throw notFound();
});
