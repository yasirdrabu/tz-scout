import { z } from 'zod';
import { defineJob } from '@/platform/events/registry';

/** Explains one open conflict in a sentence (Ruling 9). Queued when a conflict opens or gains a fact. */
export const conflictExplainJob = defineJob('accounts.conflict.explain', z.object({ conflictId: z.string() }), {
  maxDeliver: 3,
  timeoutMs: 120_000,
});
