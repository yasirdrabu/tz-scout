import { defineJobHandler } from '@/platform/runtime/jobs';
import { ScoutError } from '@/platform/errors';
import { companyCheckJob, handoffPushJob, ownersSyncJob } from './contracts/jobs';
import { checkCompany } from './services/checks';
import { runPush } from './services/handoff';
import { syncOwners } from './services/owners';

/** Checks one new account against the CRM. */
export const companyCheckHandler = defineJobHandler(companyCheckJob, async (e, ctx) => {
  await checkCompany(ctx, e.data.accountId);
});

/** Daily: reads the CRM's owner list. A token that can't read owners is not retried; the Integrations page already says so. */
export const ownersSyncHandler = defineJobHandler(ownersSyncJob, async (_e, ctx) => {
  try {
    await syncOwners(ctx);
  } catch (err) {
    if (err instanceof ScoutError && err.slug === 'owners-unreadable') return;
    throw err;
  }
});

/** Pushes one handoff to the CRM (CRM-E3). */
export const handoffPushHandler = defineJobHandler(handoffPushJob, async (e, ctx) => {
  await runPush(ctx, e.data.handoffId, new Date());
});

/** Every CRM job handler, for the worker's list. */
export const crmJobHandlers = [companyCheckHandler, ownersSyncHandler, handoffPushHandler];
