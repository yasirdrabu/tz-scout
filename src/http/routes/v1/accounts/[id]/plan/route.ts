import { getPlan } from '@/modules/playbooks';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/** The account's open plan, else its latest plan. 404 when it has none, or the account is outside the caller's data limit. */
export const GET = v1Route({ permission: 'playbooks:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const plan = await getPlan(ctx, id);
  if (!plan) throw notFound();
  return plan;
});
