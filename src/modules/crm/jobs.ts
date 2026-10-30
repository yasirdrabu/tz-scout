import { defineJobHandler } from '@/platform/runtime/jobs';
import { ScoutError } from '@/platform/errors';
import { companyCheckJob, handoffPushJob, handoffUndoJob, ownersSyncJob, personPushJob } from './contracts/jobs';
import { checkCompany } from './services/checks';
import { runPush } from './services/handoff';
import { syncOwners } from './services/owners';
import { runPersonPush } from './services/push';
import { runUndo } from './services/undo';

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

/** Undoes a handoff after a decline or withdrawal (CRM-E3-S7). */
export const handoffUndoHandler = defineJobHandler(handoffUndoJob, async (e, ctx) => {
  const { handoffId, ...why } = e.data;
  await runUndo(ctx, handoffId, new Date(), why);
});

/** Pushes a person added after the handoff (Ruling 22). */
export const personPushHandler = defineJobHandler(personPushJob, async (e, ctx) => {
  await runPersonPush(ctx, e.data.accountId, e.data.personId);
});

/** Every CRM job handler, for the worker's list. */
export const crmJobHandlers = [companyCheckHandler, ownersSyncHandler, handoffPushHandler, handoffUndoHandler, personPushHandler];
