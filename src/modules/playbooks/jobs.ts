import { defineJobHandler, type JobHandlerDef } from '@/platform/runtime/jobs';
import { briefDraftJob, briefSweepJob } from './contracts/jobs';
import { runDraft } from './services/draft';
import { sweepBriefs } from './services/sweep';

/** Drafts one account's brief (Rulings 2 to 6). */
export const briefDraftHandler = defineJobHandler(briefDraftJob, async (e, ctx) => {
  await runDraft(ctx, e.data, { jobId: e.id, queuedAt: new Date(e.occurredAt) }, new Date());
});

/** Every 15 minutes: settles or queues again the drafts stuck in `drafting`. */
export const briefSweepHandler = defineJobHandler(briefSweepJob, async (_e, ctx) => {
  await sweepBriefs(ctx, new Date());
});

/** Every playbooks job handler, for the worker's list. */
export const playbooksJobHandlers: JobHandlerDef[] = [briefDraftHandler, briefSweepHandler];
