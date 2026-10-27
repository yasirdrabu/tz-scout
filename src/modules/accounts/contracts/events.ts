import { z } from 'zod';
import { defineEvent } from '@/platform/events/registry';

export const sourceChainSchema = z.object({
  personSourceId: z.string().optional(),
  agentSourceId: z.string().optional(),
  vendorSourceId: z.string().optional(),
});

export const accountCreated = defineEvent(
  'accounts.account.created',
  1,
  z.object({
    accountId: z.string(),
    name: z.string(),
    domain: z.string().nullable(),
    isShell: z.boolean(),
    arrivalId: z.string().optional(),
  }),
);

export const accountUpdated = defineEvent(
  'accounts.account.updated',
  1,
  z.object({ accountId: z.string(), changedKeys: z.array(z.string()), arrivalId: z.string().optional() }),
);

export const accountArchived = defineEvent(
  'accounts.account.archived',
  1,
  z.object({ accountId: z.string(), reason: z.string() }),
);

export const accountMerged = defineEvent(
  'accounts.account.merged',
  1,
  z.object({ survivorId: z.string(), mergedId: z.string(), mergedBy: z.string() }),
);

export const accountExclusionChanged = defineEvent(
  'accounts.account.exclusion_changed',
  1,
  z.object({ accountId: z.string(), excludedReasonKey: z.string().optional(), override: z.boolean() }),
);

export const personAdded = defineEvent(
  'accounts.person.added',
  1,
  z.object({
    accountId: z.string(),
    personId: z.string(),
    roleKeys: z.array(z.string()),
    arrivalId: z.string().optional(),
  }),
);

export const personUpdated = defineEvent(
  'accounts.person.updated',
  1,
  z.object({
    accountId: z.string(),
    personId: z.string(),
    changedKeys: z.array(z.string()),
    roleKeys: z.array(z.string()),
  }),
);

export const factRecorded = defineEvent(
  'accounts.fact.recorded',
  1,
  z.object({
    accountId: z.string(),
    personId: z.string().optional(),
    factId: z.string(),
    key: z.string(),
    kind: z.enum(['firmographic', 'contact', 'research', 'custom', 'form_answer']),
    sourceChain: sourceChainSchema,
    becameCurrent: z.boolean(),
    arrivalId: z.string().optional(),
  }),
);

export const signalRecorded = defineEvent(
  'accounts.signal.recorded',
  1,
  z.object({
    accountId: z.string(),
    signalId: z.string(),
    type: z.string().nullable(),
    kind: z.enum(['research', 'trigger', 'pain']),
    occurredAt: z.string().nullable(),
    value: z.unknown().optional(),
    confidence: z.number().optional(),
    sourceChain: sourceChainSchema,
    arrivalId: z.string().optional(),
  }),
);
