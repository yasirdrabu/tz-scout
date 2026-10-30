import { z } from 'zod';
import { defineEvent } from '@/platform/events/registry';
import { reviewSnapshotSchema, stageSchema } from './types';

/** After every write to an account's review. `version` is `account_review.version`. */
export const reviewChanged = defineEvent(
  'routing.review.changed',
  1,
  z.object({ accountId: z.string(), version: z.number().int(), snapshot: reviewSnapshotSchema }),
);

export const statusChanged = defineEvent(
  'routing.status.changed',
  1,
  z.object({
    accountId: z.string(),
    from: z.string().nullable(),
    to: z.string(),
    countsAsReviewed: z.boolean(),
    isDeclined: z.boolean(),
    returnsToSource: z.boolean(),
    note: z.string().nullable(),
    reasonKey: z.string().nullable(),
    by: z.string(),
  }),
);

export const assignmentCreated = defineEvent(
  'routing.assignment.created',
  1,
  z.object({
    assignmentId: z.string(),
    accountId: z.string(),
    sellerUserId: z.string(),
    assignedBy: z.string(),
    templateId: z.string().nullable(),
    offerId: z.string().nullable(),
    notes: z.string().nullable(),
    ownershipDecision: z.enum(['assign', 'keep']),
    previousAssignmentId: z.string().nullable(),
    /** One id per bulk run, null for a single assign; CRM groups handoffs by it. Events stored before it parse as null. */
    bulkId: z.string().nullable().default(null),
  }),
);

export const assignmentAccepted = defineEvent(
  'routing.assignment.accepted',
  1,
  z.object({
    assignmentId: z.string(),
    accountId: z.string(),
    sellerUserId: z.string(),
    acceptedHow: z.enum(['seller', 'crm_activity', 'auto_timeout']),
  }),
);

export const assignmentDeclined = defineEvent(
  'routing.assignment.declined',
  1,
  z.object({
    assignmentId: z.string(),
    accountId: z.string(),
    sellerUserId: z.string(),
    reasonKey: z.string(),
    /** Added later, so events stored before it have none. */
    reasonLabel: z.string().optional(),
    note: z.string().nullable(),
  }),
);

export const assignmentWithdrawn = defineEvent(
  'routing.assignment.withdrawn',
  1,
  z.object({
    assignmentId: z.string(),
    accountId: z.string(),
    by: z.string(),
    replacedBy: z.string().nullable(),
  }),
);

export const stageChanged = defineEvent(
  'routing.stage.changed',
  1,
  z.object({ accountId: z.string(), from: stageSchema, to: stageSchema, causeEventId: z.string() }),
);
