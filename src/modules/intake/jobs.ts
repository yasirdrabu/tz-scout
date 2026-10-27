import { defineJobHandler } from '@/platform/runtime/jobs';
import { resolveJob } from './contracts/jobs';
import { resolveArrival } from './services/resolve';

/** Runs the resolve pipeline (SRC-E3) for one arrival. */
export const resolveHandler = defineJobHandler(resolveJob, async (e, ctx) => resolveArrival(ctx, e.data.arrivalId));
