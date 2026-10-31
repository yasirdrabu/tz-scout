import { listChanges } from '@/modules/routing';
import { pageLimit } from '../../../_lib/pagination';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/** The account's change log, newest first, paged with `cursor`. */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const url = new URL(req.url);
  return listChanges(ctx, id, { cursor: url.searchParams.get('cursor') || undefined, limit: pageLimit(url) });
});
