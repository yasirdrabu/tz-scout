import { z } from 'zod';
import { defineEvent } from '@/platform/events/registry';

export const connectionChanged = defineEvent(
  'integrations.connection.changed',
  1,
  z.object({
    connectionId: z.string(),
    provider: z.string(),
    mode: z.enum(['mock', 'live']),
    status: z.enum(['not_set_up', 'connected', 'failing', 'disabled']),
    changedBy: z.string(),
  }),
);

export const connectionTested = defineEvent(
  'integrations.connection.tested',
  1,
  z.object({
    connectionId: z.string(),
    provider: z.string(),
    ok: z.boolean(),
    message: z.string(),
    durationMs: z.number(),
  }),
);

/** R2b-1 Ruling 7: published once per level per period. `resetsAt` is ISO, `periodStart` the local date. */
export const usageThresholdReached = defineEvent(
  'integrations.usage.threshold_reached',
  1,
  z.object({
    providerKey: z.string(),
    unit: z.enum(['calls', 'credits', 'cost_cents']),
    period: z.enum(['day', 'month']),
    periodStart: z.string(),
    level: z.enum(['warn', 'blocked']),
    used: z.number(),
    limit: z.number(),
    resetsAt: z.string(),
  }),
);

/**
 * R3a Ruling 3: one successful live call that cost money, from the call log's transaction. `callId` is the call log
 * row; `units` and `unit` are what the call log holds. Sample and mock calls never publish it.
 */
export const usageRecorded = defineEvent(
  'integrations.usage.recorded',
  1,
  z.object({
    callId: z.string(),
    provider: z.string(),
    operation: z.string(),
    module: z.string().nullable(),
    units: z.number().nullable(),
    unit: z.string().nullable(),
    costCents: z.number().int().positive(),
    accountId: z.string().nullable(),
    correlationId: z.string(),
    occurredAt: z.string(),
  }),
);
