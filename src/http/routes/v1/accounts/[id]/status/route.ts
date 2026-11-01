import { getAccountStatus } from '@/modules/routing';
import { can } from '@/modules/tenancy';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/**
 * REV-E4-S2: where an account stands. `{id}` may be an `arr_` id, which resolves among the caller's own
 * arrivals. An account or arrival the caller can't see is a 404, never a 403.
 */
export const GET = v1Route({ permission: 'status:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const status = await getAccountStatus(ctx, id, { crm: can(principal, 'crm:push') });
  if (!status) throw notFound();
  return status;
});
