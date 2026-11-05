import { engagement } from '@/modules/crm';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/** How each committee person has engaged since the handoff, buyers engaged of the committee, and the first role gap (R2d Ruling 7). */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const found = await engagement(ctx, id);
  if (!found) throw notFound();
  return found;
});
