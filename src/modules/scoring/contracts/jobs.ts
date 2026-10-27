import { z } from 'zod';
import { defineJob } from '@/platform/events/registry';
import { scoreCauseSchema } from './types';

/** Rescores up to 200 accounts, each in its own savepoint. */
export const rescoreAccountsJob = defineJob(
  'scoring.rescore.accounts',
  z.object({ accountIds: z.array(z.string()).min(1).max(200), cause: scoreCauseSchema }),
  { timeoutMs: 300_000 },
);

export const rescoreFilterSchema = z.object({ practiceId: z.string().optional(), sourceId: z.string().optional(), offerId: z.string().optional() });
export type RescoreFilter = z.infer<typeof rescoreFilterSchema>;

/** Lists 200 account ids matching `filter` after `afterId`, enqueues a rescore.accounts message for them and re-enqueues itself with the cursor. */
export const rescorePageJob = defineJob(
  'scoring.rescore.page',
  z.object({ filter: rescoreFilterSchema, cause: scoreCauseSchema, afterId: z.string().optional() }),
  {},
);

/** Nightly: pages through accounts with a young signal that were last scored over 20 hours ago. One schedule per tenant. */
export const ageingJob = defineJob('scoring.ageing', z.object({ afterId: z.string().optional() }), {});
