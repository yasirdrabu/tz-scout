import { sql } from 'drizzle-orm';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { config } from '@/platform/config';
import { jetstreamManager } from '@nats-io/jetstream';
import { controlAdminDb, controlDb } from '@/platform/db/client';
import { platformDatabases } from '@/platform/db/doors';
import type { Tx } from '@/platform/db/tenant';
import { deadJob, schedule } from '@/platform/db/schema';
import { STREAMS } from '@/platform/nats/streams';
import { relayLagMs } from '@/platform/relay';

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

/** Closes the NATS connections the checks keep open. For shutdown; a later check opens a new one. */
export async function closeHealthConnections(): Promise<void> {
  const open = [...cache.values()];
  cache.clear();
  await Promise.allSettled(open.map(async (p) => (await p).close()));
}

async function checkDb(): Promise<void> {
  await Promise.race([controlDb.execute(sql`select 1`), timeout(TIMEOUT_MS)]);
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

export type ScheduleView = {
  id: string;
  tenantId: string;
  jobName: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: Date;
  lastRunAt: Date | null;
};

export type ConsumerHealth = {
  name: string;
  pending: number;
  ackPending: number;
  /** Age of the oldest message the consumer has not finished; null when it has none or it could not be read. */
  oldestAgeMs: number | null;
};

export type SystemHealth = {
  relayLagMs: number;
  consumers: ConsumerHealth[];
  /** False when NATS did not answer: `consumers` is then empty. */
  consumersAvailable: boolean;
  deadJobs: number;
  schedules: ScheduleView[];
};

async function consumerNumbers(url: string): Promise<ConsumerHealth[]> {
  const nc = await Promise.race([natsFor(url), timeout(TIMEOUT_MS)]);
  const jsm = await Promise.race([jetstreamManager(nc, { timeout: TIMEOUT_MS }), timeout(TIMEOUT_MS)]);
  const out: ConsumerHealth[] = [];
  const read = async () => {
    for (const s of STREAMS) {
      try {
        for await (const c of jsm.consumers.list(s.name)) {
          let oldestAgeMs: number | null = null;
          if (c.num_pending + c.num_ack_pending > 0) {
            // The first message on the consumer's subject after everything it has acknowledged.
            const query = { seq: c.ack_floor.stream_seq + 1, next_by_subj: c.config.filter_subject ?? '>' };
            const m = await jsm.streams.getMessage(s.name, query as never).catch(() => null);
            if (m) oldestAgeMs = Math.max(0, Date.now() - m.time.getTime());
          }
          out.push({ name: c.name, pending: c.num_pending, ackPending: c.num_ack_pending, oldestAgeMs });
        }
      } catch (e) {
        // A stream that does not exist yet has no consumers.
        if (!/not found/i.test(String((e as Error).message))) throw e;
      }
    }
  };
  await Promise.race([read(), timeout(TIMEOUT_MS * 2)]);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What the System page shows: relay lag, queue numbers per consumer, dead jobs and schedules. When NATS
 * does not answer, the database parts still come back and `consumersAvailable` is false. The database
 * parts cover every database with an outbox (`platformDatabases`): the worst lag, every dead job and
 * schedule. The control plane's are read in `tx` when given.
 */
export async function systemHealth(opts: { natsUrl?: string; tx?: Tx } = {}): Promise<SystemHealth> {
  const url = opts.natsUrl ?? config.natsUrl;
  const readDatabases = async () => {
    let lag = 0;
    let dead = 0;
    const schedules: (typeof schedule.$inferSelect)[] = [];
    const databases = await platformDatabases();
    for (const d of databases) {
      const db = d.control ? (opts.tx ?? controlAdminDb) : d.admin;
      lag = Math.max(lag, await relayLagMs(db));
      dead += (await db.select({ n: sql<number>`count(*)::int` }).from(deadJob))[0]?.n ?? 0;
      schedules.push(...(await db.select().from(schedule).orderBy(schedule.jobName, schedule.tenantId)));
    }
    const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    if (databases.length > 1) schedules.sort((a, b) => byName(a.jobName, b.jobName) || byName(a.tenantId, b.tenantId));
    return { lag, dead, schedules };
  };
  const [{ lag, dead, schedules }, consumers] = await Promise.all([
    readDatabases(),
    consumerNumbers(url).then(
      (c) => ({ ok: true as const, c }),
      () => ({ ok: false as const, c: [] as ConsumerHealth[] }),
    ),
  ]);
  return {
    relayLagMs: lag,
    consumers: consumers.c,
    consumersAvailable: consumers.ok,
    deadJobs: dead,
    schedules: schedules.map((s) => ({
      id: s.id,
      tenantId: s.tenantId,
      jobName: s.jobName,
      cron: s.cron,
      timezone: s.timezone,
      enabled: s.enabled,
      nextRunAt: s.nextRunAt,
      lastRunAt: s.lastRunAt,
    })),
  };
}
