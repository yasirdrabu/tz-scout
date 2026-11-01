// Loads every module's job and event definitions into this process, so "Run now" can find module jobs.
import '@/entry/registry';
import { pauseSchedule, resumeSchedule, runNow } from '@/platform/scheduler';
import { idAndAction } from '../../../_lib/path';
import { adminByAction, adminRoute, noContent } from '../../../_lib/v1-route';

const scheduleId = (req: Request) => idAndAction(req, 'schedules').id;

// POST /api/v1/admin/schedules/{id}:pause, :resume and :run-now. Audited by the scheduler services.
export const POST = adminByAction('schedules', {
  pause: adminRoute({}, async (req, _person, ctx) => {
    await pauseSchedule(ctx, scheduleId(req));
    return noContent();
  }),
  /** Resuming recomputes the next run from now. */
  resume: adminRoute({}, async (req, _person, ctx) => {
    await resumeSchedule(ctx, scheduleId(req));
    return noContent();
  }),
  /** Starts the job now; the next run stays as it was. */
  'run-now': adminRoute({}, async (req, _person, ctx) => ({
    jobId: await runNow(ctx, scheduleId(req)),
  })),
});
