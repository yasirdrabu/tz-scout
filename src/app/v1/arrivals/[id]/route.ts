import { getArrival } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { withoutContacts } from '../../_lib/intake';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

export const GET = v1Route({ permission: 'arrivals:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'arrivals');
  if (action) throw notFound();
  const found = await getArrival(ctx, id);
  if (!found) throw notFound();
  return can(principal, 'people:read') ? found : withoutContacts(found);
});
