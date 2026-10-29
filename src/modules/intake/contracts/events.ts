import { z } from 'zod';
import { sourceChainSchema } from '@/modules/accounts/contracts/events';
import { defineEvent } from '@/platform/events/registry';

export const batchCreated = defineEvent(
  'intake.batch.created',
  1,
  z.object({
    batchId: z.string(),
    sourceChain: sourceChainSchema,
    name: z.string(),
    runAt: z.string(),
    itemCount: z.number().int(),
  }),
);

export const arrivalReceived = defineEvent(
  'intake.arrival.received',
  1,
  z.object({
    arrivalId: z.string(),
    batchId: z.string().optional(),
    sourceChain: sourceChainSchema,
    targetAccountId: z.string().optional(),
    externalRef: z.string().optional(),
  }),
);

export const arrivalWaiting = defineEvent(
  'intake.arrival.waiting',
  1,
  z.object({
    arrivalId: z.string(),
    batchId: z.string().optional(),
    waitingOn: z.enum(['needs_website', 'needs_company', 'possible_duplicate']),
    candidates: z
      .array(z.object({ accountId: z.string(), name: z.string(), domain: z.string().nullable(), score: z.number() }))
      .optional(),
  }),
);

export const arrivalResolved = defineEvent(
  'intake.arrival.resolved',
  1,
  z.object({
    arrivalId: z.string(),
    batchId: z.string().optional(),
    accountId: z.string(),
    resolution: z.enum(['created', 'attached']),
    sourceChain: sourceChainSchema,
    isFirstFromSource: z.boolean(),
    initialReviewStatusKey: z.string(),
    effectiveTrust: z.number(),
    warmIntro: z
      .object({
        warmIntroId: z.string(),
        relationshipKey: z.string(),
        points: z.number().int(), // the effective points (halved while unconfirmed)
        confirmed: z.boolean(),
      })
      .optional(),
    practiceHint: z.string().optional(),
    offerHint: z.string().optional(),
  }),
);

export const arrivalRejected = defineEvent(
  'intake.arrival.rejected',
  1,
  z.object({
    arrivalId: z.string(),
    batchId: z.string().optional(),
    reason: z.enum(['invalid', 'excluded', 'daily_cap_reached', 'duplicate_in_batch']),
    detail: z.string(),
    accountId: z.string().optional(),
  }),
);

export const sourceTrustChanged = defineEvent(
  'intake.source.trust_changed',
  1,
  z.object({
    sourceId: z.string(),
    level: z.enum(['person', 'agent', 'vendor']),
    from: z.number(),
    to: z.number(),
    sampleSize: z.number().int(),
    cause: z.enum(['outcomes', 'conflict_lost', 'warm_intro_points']),
  }),
);

export const batchCompleted = defineEvent(
  'intake.batch.completed',
  1,
  z.object({
    batchId: z.string(),
    counts: z.object({
      resolved: z.number().int(),
      rejected: z.number().int(),
      newAccounts: z.number().int(),
      alreadyKnown: z.number().int(),
    }),
    reportedCost: z
      .object({ credits: z.number().optional(), costCents: z.number().optional(), currency: z.string().optional() })
      .optional(),
  }),
);

export const feedbackRecorded = defineEvent(
  'intake.feedback.recorded',
  1,
  z.object({
    sourceId: z.string(),
    arrivalId: z.string(),
    accountId: z.string(),
    kind: z.enum(['conflict_lost', 'declined_at_review', 'sent_back', 'declined_by_seller', 'enrichment_declined']),
    reasonKey: z.string().nullable(),
    note: z.string().nullable(),
  }),
);
