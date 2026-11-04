import { getCommittee } from '@/modules/accounts';
import { getBrief } from '@/modules/playbooks';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/** PLB-E3: the account's brief, each piece with who wrote it, plus the buying committee for the lead offer. A missing or hidden account is a 404, never a 403. */
export const GET = v1Route({ permission: 'playbooks:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const brief = await getBrief(ctx, id);
  if (!brief) throw notFound();
  return { ...brief, committee: await getCommittee(ctx, id) };
});
