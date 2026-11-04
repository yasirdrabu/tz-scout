import { z } from 'zod';
import { defineJob } from '@/platform/events/registry';

/** Runs one approved request (Ruling 8). A usage-limit wait is not counted as a try. */
export const runRequestJob = defineJob('enrichment.request.run', z.object({ requestId: z.string() }), {
  maxDeliver: 5,
  timeoutMs: 120_000,
  backoffMs: [30_000, 120_000, 600_000, 3_600_000],
});

/** Daily at 04:00 UTC, one schedule per tenant: cancels requests flagged for 14 days (Ruling 7). */
export const expireRequestsJob = defineJob('enrichment.request.expire', z.object({}), {});
