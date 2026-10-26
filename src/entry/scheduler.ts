import './registry';
import { log } from '@/platform/log';
import { runScheduler } from '@/platform/scheduler';

/** Scheduler role: publishes due cron jobs. Runs until SIGINT or SIGTERM. */
export async function main(): Promise<void> {
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  log.info('scheduler: starting');
  await runScheduler({ signal: ac.signal });
  log.info('scheduler: stopped');
}

if (process.argv[1] && /scheduler\.[cm]?[jt]s$/.test(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (e) => {
      log.error({ err: (e as Error).message }, 'scheduler: fatal');
      process.exit(1);
    },
  );
}
