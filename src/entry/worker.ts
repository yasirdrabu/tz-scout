import './registry';
import { accountsCrmStatusConsumers, accountsSummaryOnReviewChanged, accountsSummaryOnScored, accountsTenantDefaults, exclusionsRecheckHandler } from '@/modules/accounts';
import { importRunHandler, intakeAccountMerged, intakeSellerDeclineFeedback, intakeStatusFeedback, intakeTenantDefaults, resolveHandler, waitingExpireHandler } from '@/modules/intake';
import { crmConsumers, crmJobHandlers } from '@/modules/crm';
import { credentialsCleanupHandler } from '@/modules/integrations';
import { autoAcceptHandler, routingConsumers } from '@/modules/routing';
import { ageingHandler, rescoreAccountsHandler, rescorePageHandler, scoringConsumers } from '@/modules/scoring';
import { pingHandler } from '@/platform/diagnostics';
import { log } from '@/platform/log';
import type { ConsumerDef } from '@/platform/runtime/consumers';
import type { JobHandlerDef } from '@/platform/runtime/jobs';
import { startWorker } from '@/platform/runtime/worker';

/** Every consumer in the app. Modules add theirs here as they land. */
export const consumers: ConsumerDef[] = [accountsTenantDefaults, accountsSummaryOnReviewChanged, accountsSummaryOnScored, ...accountsCrmStatusConsumers, intakeTenantDefaults, intakeAccountMerged, intakeStatusFeedback, intakeSellerDeclineFeedback, ...scoringConsumers, ...routingConsumers, ...crmConsumers];

/** Every job handler in the app. */
export const jobs: JobHandlerDef[] = [pingHandler, credentialsCleanupHandler, exclusionsRecheckHandler, resolveHandler, waitingExpireHandler, importRunHandler, rescoreAccountsHandler, rescorePageHandler, ageingHandler, autoAcceptHandler, ...crmJobHandlers];

/** Worker role: consumers and job handlers. Runs until SIGINT or SIGTERM. */
export async function main(): Promise<void> {
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  log.info('worker: starting');
  await startWorker({ consumers, jobs, signal: ac.signal });
  log.info('worker: stopped');
}

if (process.argv[1] && /worker\.[cm]?[jt]s$/.test(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (e) => {
      log.error({ err: (e as Error).message }, 'worker: fatal');
      process.exit(1);
    },
  );
}
