import { log } from '@/platform/log';
import { runRelay } from '@/platform/relay';

/** Relay role: outbox to NATS. Runs until SIGINT or SIGTERM. */
export async function main(): Promise<void> {
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  log.info('relay: starting');
  await runRelay({ signal: ac.signal });
  log.info('relay: stopped');
}

if (process.argv[1] && /relay\.[cm]?[jt]s$/.test(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (e) => {
      log.error({ err: (e as Error).message }, 'relay: fatal');
      process.exit(1);
    },
  );
}
