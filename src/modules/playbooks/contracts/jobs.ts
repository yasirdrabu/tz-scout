import { z } from 'zod';
import { defineJob } from '@/platform/events/registry';

/** Drafts one account's brief (Rulings 2 to 5). Requests coalesce on the brief row, so one run may cover many. */
export const briefDraftJob = defineJob(
  'playbooks.brief.draft',
  z.object({ accountId: z.string(), manual: z.boolean(), includeEdited: z.array(z.string()) }),
  { maxDeliver: 3, timeoutMs: 90_000 },
);
