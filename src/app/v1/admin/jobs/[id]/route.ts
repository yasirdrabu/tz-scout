import { discardDeadJob, retryDeadJob } from '@/platform/dead-jobs';
import { idAndAction } from '../../../_lib/path';
import { adminByAction, adminRoute, noContent } from '../../../_lib/v1-route';

export const dynamic = 'force-dynamic';

// POST /v1/admin/jobs/{id}:retry and :discard, for dead jobs. Both are audited by the platform services.
export const POST = adminByAction('jobs', {
  /** Sends the work again; `sent_id` is the new job id, or the event id for an event. */
  retry: adminRoute({}, async (req, _person, ctx) => ({
    sentId: await retryDeadJob(ctx, idAndAction(req, 'jobs').id),
  })),
  /** Removes the dead job without running it. */
  discard: adminRoute({}, async (req, _person, ctx) => {
    await discardDeadJob(ctx, idAndAction(req, 'jobs').id);
    return noContent();
  }),
});
