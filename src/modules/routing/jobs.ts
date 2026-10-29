import { defineJobHandler } from '@/platform/runtime/jobs';
import { autoAcceptJob } from './contracts/jobs';
import { autoAccept } from './services/respond';

/** Hourly: accepts the assignments that waited out the tenant's working days. */
export const autoAcceptHandler = defineJobHandler(autoAcceptJob, async (_e, ctx) => {
  await autoAccept(ctx, new Date());
});
