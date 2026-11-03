import { defineJobHandler, type JobHandlerDef } from '@/platform/runtime/jobs';
import { expireRequestsJob, runRequestJob } from './contracts/jobs';
import { expireFlagged } from './services/expire';
import { runRequest } from './services/run';

/** Carries out an approved request (Ruling 8). A usage-limit wait is not counted as a try. */
export const runRequestHandler = defineJobHandler(runRequestJob, async (e, ctx) => {
  await runRequest(ctx, e.data.requestId);
});

/** Daily: cancels requests flagged for 14 days (Ruling 7). */
export const expireRequestsHandler = defineJobHandler(expireRequestsJob, async (_e, ctx) => {
  await expireFlagged(ctx, new Date());
});

/** Every enrichment job handler, for the worker's list. */
export const enrichmentJobHandlers: JobHandlerDef[] = [runRequestHandler, expireRequestsHandler];
