import { getAccountReview } from '@/modules/routing';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/** The account's review: status with who and when, stage dates, the open assignment with names, sources and version. */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  return getAccountReview(ctx, id);
});
