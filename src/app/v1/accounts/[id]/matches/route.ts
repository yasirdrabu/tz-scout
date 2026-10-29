import { getAccount } from '@/modules/accounts';
import { getMatches } from '@/modules/scoring';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

export const dynamic = 'force-dynamic';

/** Every approved offer's match for the account, best first. A hidden or missing account is a 404. */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action || !(await getAccount(ctx, id))) throw notFound();
  return { data: (await getMatches(ctx, id)).map(({ tenantId: _t, ...m }) => m) };
});
