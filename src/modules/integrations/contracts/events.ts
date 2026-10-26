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
