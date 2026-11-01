import { defineJobHandler, type JobHandlerDef } from '@/platform/runtime/jobs';
import { briefDraftJob } from './contracts/jobs';
import { runDraft } from './services/draft';

/** Drafts one account's brief (Rulings 2 to 6). */
export const briefDraftHandler = defineJobHandler(briefDraftJob, async (e, ctx) => {
  await runDraft(ctx, e.data, new Date());
});

/** Every playbooks job handler, for the worker's list. */
export const playbooksJobHandlers: JobHandlerDef[] = [briefDraftHandler];
