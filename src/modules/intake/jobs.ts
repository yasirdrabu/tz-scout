import { defineJobHandler } from '@/platform/runtime/jobs';
import { importRunJob, qualifiedLeadsPollJob, resolveJob, waitingExpireJob } from './contracts/jobs';
import { runImport } from './services/imports';
import { pollQualifiedLeads } from './services/qualified-leads';
import { resolveArrival } from './services/resolve';
import { expireWaiting } from './services/waiting';

/** Runs the resolve pipeline (SRC-E3) for one arrival. */
export const resolveHandler = defineJobHandler(resolveJob, async (e, ctx) => resolveArrival(ctx, e.data.arrivalId));

/** Rejects arrivals that have waited 30 days for a person (SRC-E3-S3-AC3). */
export const waitingExpireHandler = defineJobHandler(waitingExpireJob, async (_e, ctx) => {
  await expireWaiting(ctx);
});

/** Reads an uploaded file with its confirmed mapping and submits one arrival per company (SRC-E4). */
export const importRunHandler = defineJobHandler(importRunJob, async (e, ctx) => runImport(ctx, e.data.importId, e.data.cursor ?? 0));

/** Every 15 minutes: contacts the CRM marked qualified come in as arrivals (SRC-E6-S1, Ruling 14). */
export const qualifiedLeadsPollHandler = defineJobHandler(qualifiedLeadsPollJob, async (_e, ctx) => {
  await pollQualifiedLeads(ctx);
});
