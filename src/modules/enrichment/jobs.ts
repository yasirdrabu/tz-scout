import { defineJobHandler, type JobHandlerDef } from '@/platform/runtime/jobs';
import { expireRequestsJob } from './contracts/jobs';
import { expireFlagged } from './services/expire';

/** Daily: cancels requests flagged for 14 days (Ruling 7). */
export const expireRequestsHandler = defineJobHandler(expireRequestsJob, async (_e, ctx) => {
  await expireFlagged(ctx, new Date());
});

/** Every enrichment job handler, for the worker's list. The run handler arrives with the run (Task 4). */
export const enrichmentJobHandlers: JobHandlerDef[] = [expireRequestsHandler];
