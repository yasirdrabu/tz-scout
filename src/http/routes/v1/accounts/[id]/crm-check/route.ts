import { crmCheckCard } from '@/modules/crm';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/** The In HubSpot card (screens.md §4a): the stored CRM check, or `{ exists: null, checked_at: null }` when never checked. */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  return crmCheckCard(ctx, id);
});
