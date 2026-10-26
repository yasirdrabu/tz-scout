// Worker and relay for the e2e run. Started by background.ts through tsx (it resolves the `@/` alias).
// Prints READY once the worker is consuming. Stops when stdin closes or receives "stop".
async function main() {
  await import('@/entry/registry');
  const { jobs, consumers } = await import('@/entry/worker');
  const { startWorker } = await import('@/platform/runtime/worker');
  const { runRelay } = await import('@/platform/relay');
  const { connectNats } = await import('@/platform/nats/connection');
  const { ensureStreams } = await import('@/platform/nats/streams');
  const { closeDbs } = await import('@/platform/db/client');

  // Leftover pings from an earlier run would be handled against this database.
  const nats = await connectNats();
  await ensureStreams(nats.jsm);
  await nats.jsm.streams.purge('SCOUT_JOBS', { filter: 'scout.*.jobs.platform.ping' });
  await nats.nc.drain();

  const ac = new AbortController();
  process.stdin.on('data', (d) => String(d).includes('stop') && ac.abort());
  process.stdin.on('end', () => ac.abort());
  const worker = startWorker({ jobs, consumers, signal: ac.signal, onReady: () => console.log('READY') });
  const relay = runRelay({ signal: ac.signal });
  await Promise.all([worker, relay]);
  await closeDbs();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
