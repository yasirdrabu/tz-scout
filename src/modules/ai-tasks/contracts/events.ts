import { z } from 'zod';
import { defineEvent } from '@/platform/events/registry';

export const aiRunCompleted = defineEvent(
  'ai.run.completed',
  1,
  z.object({
    runId: z.string(),
    task: z.string(),
    promptVersion: z.string(),
    mode: z.enum(['live', 'rules', 'mock']),
    model: z.string().nullable(),
    status: z.enum(['ok', 'invalid_output', 'error', 'refused_by_cap']),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costCents: z.number(),
    subject: z.object({ type: z.string(), id: z.string() }),
    correlationId: z.string(),
  }),
);
