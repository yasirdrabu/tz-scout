import { defineJobHandler } from '@/platform/runtime/jobs';
import { resolveJob, waitingExpireJob } from './contracts/jobs';
import { resolveArrival } from './services/resolve';
import { expireWaiting } from './services/waiting';

/** Runs the resolve pipeline (SRC-E3) for one arrival. */
export const resolveHandler = defineJobHandler(resolveJob, async (e, ctx) => resolveArrival(ctx, e.data.arrivalId));

/** Rejects arrivals that have waited 30 days for a person (SRC-E3-S3-AC3). */
export const waitingExpireHandler = defineJobHandler(waitingExpireJob, async (_e, ctx) => {
  await expireWaiting(ctx);
});
