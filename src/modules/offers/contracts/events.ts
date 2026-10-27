import { z } from 'zod';
import { defineEvent } from '@/platform/events/registry';

export const offerApproved = defineEvent(
  'offers.offer.approved',
  1,
  z.object({ offerId: z.string(), practiceId: z.string(), approvedBy: z.string() }),
);

export const offerChanged = defineEvent(
  'offers.offer.changed',
  1,
  z.object({
    offerId: z.string(),
    practiceId: z.string(),
    changed: z.array(z.string()),
    /** Fit criteria or status changed, so Scoring rescores. */
    affectsMatching: z.boolean(),
  }),
);

export const offerArchived = defineEvent(
  'offers.offer.archived',
  1,
  z.object({ offerId: z.string(), practiceId: z.string() }),
);

export const practiceChanged = defineEvent(
  'offers.practice.changed',
  1,
  z.object({ practiceId: z.string(), changed: z.array(z.string()) }),
);
