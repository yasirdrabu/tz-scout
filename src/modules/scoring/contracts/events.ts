import { z } from 'zod';
import { defineEvent } from '@/platform/events/registry';
import { revenueBandSchema, scoreCauseSchema, tierSchema } from './types';

/** Published when priority, tier or best offer changed, or on the first score. `version` is `account_score.version`. */
export const accountScored = defineEvent(
  'scoring.account.scored',
  1,
  z.object({
    accountId: z.string(),
    priority: z.number().int(),
    fit: z.number().int(),
    intent: z.number().int(),
    tier: tierSchema,
    previousTier: tierSchema.nullable(),
    bestOfferId: z.string().nullable(),
    previousBestOfferId: z.string().nullable(),
    practiceId: z.string().nullable(),
    revenueBand: revenueBandSchema.nullable(),
    cause: scoreCauseSchema,
    profileVersion: z.number().int(),
    version: z.number().int(),
  }),
);

export const rulesChanged = defineEvent(
  'scoring.rules.changed',
  1,
  z.object({ profileVersion: z.number().int(), changed: z.array(z.string()), changedBy: z.string() }),
);
