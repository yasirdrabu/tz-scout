import {
  approveOffer,
  archiveOffer,
  deleteOffer,
  getOffer,
  getPractice,
  listCaseStudies,
  offerCanDelete,
  resetSignalRules,
  unapproveOffer,
  updateOffer,
  withLabel,
  type OfferPatch,
} from '@/modules/offers';
import { can } from '@/modules/tenancy';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { byAction, noContent, v1Route } from '../../_lib/v1-route';
import { checkBuyingRoles } from '../roles';
import { patchOfferBody } from '../schemas';

// People without `offers:manage` can read approved offers only; a draft is a 404 to them.
export const GET = v1Route({ permission: 'offers:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'offers');
  if (action) throw notFound();
  const offer = await getOffer(ctx, id);
  if (offer.status !== 'approved' && !can(principal, 'offers:manage')) throw notFound();
  const caseStudies = await listCaseStudies(ctx, { offerId: id, buyerVisibleOnly: principal.kind !== 'user' });
  const practice = await getPractice(ctx, offer.practiceId);
  return {
    ...(await withLabel(ctx, offer)),
    practiceLeadName: practice.leadName,
    canDelete: await offerCanDelete(ctx, id),
    caseStudies,
  };
});

export const PATCH = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'offers');
  if (action) throw notFound();
  const patch = await parseBody<OfferPatch>(req, patchOfferBody);
  if (patch.targetBuyingRoles !== undefined || patch.optionalBuyingRoles !== undefined) {
    await checkBuyingRoles(ctx, patch, await getOffer(ctx, id));
  }
  const { offer, warning } = await updateOffer(ctx, id, patch);
  const view = await withLabel(ctx, offer);
  return warning ? { ...view, warning } : view;
});

/** Ruling 12: 204 when the offer never matched and was never a lead offer, else 409 `offer-has-history`. */
export const DELETE = v1Route({ permission: 'offers:manage', peopleOnly: 'Only a person can delete an offer.' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'offers');
  if (action) throw notFound();
  await deleteOffer(ctx, id);
  return noContent();
});

// POST /api/v1/offers/{id}:approve, :unapprove, :archive and :reset-signal-rules
export const POST = byAction('offers', {
  approve: v1Route({ permission: 'offers:manage', peopleOnly: 'Only a person can approve an offer.' }, async (req, _principal, ctx) =>
    withLabel(ctx, await approveOffer(ctx, idAndAction(req, 'offers').id)),
  ),
  unapprove: v1Route({ permission: 'offers:manage', peopleOnly: 'Only a person can unapprove an offer.' }, async (req, _principal, ctx) =>
    withLabel(ctx, await unapproveOffer(ctx, idAndAction(req, 'offers').id)),
  ),
  archive: v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) => withLabel(ctx, await archiveOffer(ctx, idAndAction(req, 'offers').id))),
  'reset-signal-rules': v1Route({ permission: 'scoring:manage' }, async (req, _principal, ctx) => ({
    data: await resetSignalRules(ctx, idAndAction(req, 'offers').id),
  })),
});
