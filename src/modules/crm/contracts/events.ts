import { z } from 'zod';
import { defineEvent } from '@/platform/events/registry';
import { activityKindSchema, companyLifecycleSchema, dealStatusSchema, ownershipActionSchema } from './types';

export const handoffCompleted = defineEvent(
  'crm.handoff.completed',
  1,
  z.object({
    handoffId: z.string(),
    accountId: z.string(),
    assignmentId: z.string(),
    handoffBatchId: z.string().nullable(),
    system: z.string(),
    companyExternalId: z.string(),
    personExternalIds: z.array(z.string()),
    ownerExternalId: z.string().nullable(),
    ownershipAction: ownershipActionSchema,
    takenFromOwner: z.string().nullable(),
    taskCount: z.number().int(),
    companyLifecycle: companyLifecycleSchema,
    observedAt: z.string(),
  }),
);

export const handoffFailed = defineEvent(
  'crm.handoff.failed',
  1,
  z.object({
    handoffId: z.string(),
    accountId: z.string(),
    assignmentId: z.string(),
    system: z.string(),
    attempt: z.number().int(),
    retryable: z.boolean(),
    reason: z.string(),
  }),
);

export const handoffNeedsDecision = defineEvent(
  'crm.handoff.needs_decision',
  1,
  z.object({
    handoffId: z.string(),
    accountId: z.string(),
    assignmentId: z.string(),
    reason: z.enum(['open_deal', 'customer', 'owned_elsewhere']),
    currentOwnerName: z.string().nullable(),
  }),
);

/** Internal. A handoff that was declined, withdrawn or stopped before it finished. */
export const handoffCancelled = defineEvent(
  'crm.handoff.cancelled',
  1,
  z.object({ handoffId: z.string(), accountId: z.string(), assignmentId: z.string(), at: z.string() }),
);

export const activityObserved = defineEvent(
  'crm.activity.observed',
  1,
  z.object({
    accountId: z.string(),
    handoffId: z.string().nullable(),
    system: z.string(),
    externalId: z.string(),
    kind: activityKindSchema,
    occurredAt: z.string(),
    actorCrmOwnerId: z.string().nullable(),
    actorUserId: z.string().nullable(),
    taskExternalId: z.string().nullable().optional(),
    stepId: z.string().nullable().optional(),
  }),
);

export const dealChanged = defineEvent(
  'crm.deal.changed',
  1,
  z.object({
    accountId: z.string(),
    system: z.string(),
    dealExternalId: z.string(),
    status: dealStatusSchema,
    previousStatus: dealStatusSchema.nullable(),
    stage: z.string().nullable(),
    amountCents: z.number().int().nullable(),
    currency: z.string().nullable(),
    openedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    companyLifecycle: companyLifecycleSchema,
    observedAt: z.string(),
  }),
);

/** The CRM check before review (Ruling 11). */
export const companyChecked = defineEvent(
  'crm.company.checked',
  1,
  z.object({
    accountId: z.string(),
    system: z.string(),
    exists: z.boolean(),
    companyExternalId: z.string().nullable(),
    ownerName: z.string().nullable(),
    companyLifecycle: companyLifecycleSchema,
    observedAt: z.string(),
  }),
);

/** A contact's lifecycle change matched the qualified-lead rule; Intake consumes it (Ruling 15). */
export const leadQualified = defineEvent('crm.lead.qualified', 1, z.object({ connectionId: z.string(), contactId: z.string() }));
