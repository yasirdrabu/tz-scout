import { ACTIVITY_PAGE, activityCursor, listActivity } from '@/modules/crm';
import { decodeCursor, page } from '../../../_lib/pagination';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/** HubSpot activity and Scout's own actions on the account, newest first, 25 a page (screens.md §4b). */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const cursor = activityCursor(decodeCursor(new URL(req.url).searchParams.get('cursor')));
  const { rows, syncedAt } = await listActivity(ctx, id, cursor);
  const { items, nextCursor } = page(rows, ACTIVITY_PAGE, (r) => ({ at: r.at.toISOString(), id: r.id }));
  return { data: items, nextCursor, syncedAt };
});
