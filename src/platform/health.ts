import { sql } from 'drizzle-orm';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { config } from '@/platform/config';
import { appDb } from '@/platform/db/client';

const TIMEOUT_MS = 2000;

const timeout = (ms: number): Promise<never> =>
  new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms).unref?.());

const cache = new Map<string, Promise<NatsConnection>>();

/** One NATS connection per url, reused across requests. A failed or closed connection is dropped. */
function natsFor(url: string): Promise<NatsConnection> {
  let p = cache.get(url);
  if (!p) {
    p = connect({ servers: url, name: 'scout-readyz', timeout: TIMEOUT_MS, maxReconnectAttempts: -1 });
    cache.set(url, p);
    p.then(
      (nc) => void nc.closed().then(() => cache.get(url) === p && cache.delete(url)),
      () => cache.get(url) === p && cache.delete(url),
    );
  }
  return p;
}

async function checkDb(): Promise<void> {
  await Promise.race([appDb.execute(sql`select 1`), timeout(TIMEOUT_MS)]);
}

async function checkNats(url: string): Promise<void> {
  const nc = await Promise.race([natsFor(url), timeout(TIMEOUT_MS)]);
  await Promise.race([nc.flush(), timeout(TIMEOUT_MS)]);
}

export type Readiness = { ok: boolean; failing: ('database' | 'nats')[] };

/** Database `select 1` and NATS flush, each within 2 seconds. */
export async function checkReady(opts: { natsUrl?: string } = {}): Promise<Readiness> {
  const url = opts.natsUrl ?? config.natsUrl;
  const [db, nats] = await Promise.allSettled([checkDb(), checkNats(url)]);
  const failing: Readiness['failing'] = [];
  if (db.status === 'rejected') failing.push('database');
  if (nats.status === 'rejected') failing.push('nats');
  return { ok: failing.length === 0, failing };
}

/** The `/readyz` response: 200, or 503 naming the failing dependency. */
export async function readyResponse(opts: { natsUrl?: string } = {}): Promise<Response> {
  const r = await checkReady(opts);
  return Response.json(r.ok ? { ok: true } : { ok: false, failing: r.failing }, {
    status: r.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
