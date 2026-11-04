import { getCommittee } from '@/modules/accounts';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/** ACC-E2-S1: who covers the buying roles for the lead offer (or `?offer_id=`). A missing or hidden account or unknown offer is a 404. */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const offerId = new URL(req.url).searchParams.get('offer_id') || undefined;
  return getCommittee(ctx, id, offerId);
});
