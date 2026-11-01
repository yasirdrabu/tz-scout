import { z } from 'zod';
import { defineJob } from '@/platform/events/registry';

/** Runs of a draft job; the last one drafts from rules only, so it cannot time out on Claude (Ruling 5). */
export const DRAFT_MAX_ATTEMPTS = 3;

/**
 * Drafts one account's brief (Rulings 2 to 5). Requests coalesce on the brief row, so one run may cover many.
 * `seq` is the request number it was queued for: a run finds it covered when a newer draft already reached it.
 * A live run may ask Claude twice (the second time with the problems listed), hence four minutes.
 */
export const briefDraftJob = defineJob(
  'playbooks.brief.draft',
  z.object({ accountId: z.string(), manual: z.boolean(), includeEdited: z.array(z.string()), seq: z.number().int().optional() }),
  { maxDeliver: DRAFT_MAX_ATTEMPTS, timeoutMs: 240_000 },
);

/** Every 15 minutes, one schedule per tenant: settles or queues again drafts stuck in `drafting`. */
export const briefSweepJob = defineJob('playbooks.brief.sweep', z.object({}), {});
