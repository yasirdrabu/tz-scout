import { z } from 'zod';
import { defineEvent } from '@/platform/events/registry';
import { ERROR_KINDS, KINDS } from './types';

const kind = z.enum(KINDS);
const estimate = z.object({ credits: z.number().int().nonnegative(), costCents: z.number().int().nonnegative() });

/** A request waits for a person with `enrichment:approve` (Ruling 1). */
export const requestFlagged = defineEvent(
  'enrichment.request.flagged',
  1,
  z.object({
    requestId: z.string(),
    accountId: z.string(),
    kind,
    requestedBy: z.string(),
    requestedByLabel: z.string(),
    requestingSourceId: z.string().optional(),
    reason: z.string(),
    estimate,
  }),
);

/** Approved, by a person or by an approver creating it; the run job is queued in the same transaction (Ruling 8). */
export const requestApproved = defineEvent(
  'enrichment.request.approved',
  1,
  z.object({ requestId: z.string(), accountId: z.string(), kind, providerKey: z.string(), decidedBy: z.string(), requestedByLabel: z.string() }),
);

export const requestDeclined = defineEvent(
  'enrichment.request.declined',
  1,
  z.object({ requestId: z.string(), accountId: z.string(), decidedBy: z.string(), reason: z.string() }),
);

/** Cancelled by a person, or `reason: 'expired'` after 14 days flagged (Ruling 7). */
export const requestCancelled = defineEvent(
  'enrichment.request.cancelled',
  1,
  z.object({ requestId: z.string(), accountId: z.string(), reason: z.string() }),
);

/** Also on a `partial` run: what was found was kept. */
export const requestCompleted = defineEvent(
  'enrichment.request.completed',
  1,
  z.object({
    requestId: z.string(),
    accountId: z.string(),
    kind,
    providerKey: z.string(),
    arrivalIds: z.array(z.string()),
    found: z.number().int().nonnegative(),
    creditsUsed: z.number().nonnegative(),
    costCents: z.number().int().nonnegative(),
    currency: z.string(),
    requestedBy: z.string(),
    requestingSourceId: z.string().optional(),
  }),
);

export const requestFailed = defineEvent(
  'enrichment.request.failed',
  1,
  z.object({
    requestId: z.string(),
    accountId: z.string(),
    providerKey: z.string(),
    errorKind: z.enum(ERROR_KINDS),
    message: z.string(),
    creditsUsed: z.number().nonnegative(),
    costCents: z.number().int().nonnegative(),
  }),
);
