import { getRun } from '@/modules/ai-tasks';
import { runDetail } from '../../_lib/ai-runs';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

/** One of this workspace's runs, with what came back and the error. */
export const GET = v1Route({ permission: 'settings:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'ai-runs');
  if (action) throw notFound();
  const run = await getRun(ctx, id);
  if (!run) throw notFound();
  return runDetail(run);
});
