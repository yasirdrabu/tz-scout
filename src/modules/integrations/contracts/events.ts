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
