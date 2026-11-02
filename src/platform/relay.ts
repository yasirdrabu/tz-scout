import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { config } from '@/platform/config';
import { controlAdminDb } from '@/platform/db/client';
import { platformDatabases, type PlatformDatabase } from '@/platform/db/doors';
import { urlForDatabase } from '@/platform/db/workspace-pools';
import { log } from '@/platform/log';
import { errorText } from '@/platform/scrub-error';
import { connectNats, type Nats } from '@/platform/nats/connection';
import { ensureStreams } from '@/platform/nats/streams';

export type RelayOptions = {
  signal: AbortSignal;
  batchSize?: number;
  idleMs?: number;
  /** Defaults to NATS_URL. */
  natsUrl?: string;
};

export type OutboxRow = { seq: number; id: string; nats_subject: string; payload: unknown };

/**
 * `LISTEN`s for new outbox rows in each workspace database (the trigger `platform.notify_outbox` fires
 * there too), on a connection of its own per database, up to `cap` of them (SCOUT_RELAY_POOL_CAP): one
 * past the cap is only polled. A connection that fails is dropped and opened again on a later turn.
 */
class WorkspaceListeners {
  private open = new Map<string, postgres.Sql>();
  constructor(private notified: (database: string) => void) {}

  async sync(databases: string[], cap: number): Promise<void> {
    for (const [d, sql] of this.open) {
      if (!databases.includes(d)) {
        this.open.delete(d);
        await sql.end({ timeout: 2 }).catch(() => {});
      }
    }
    for (const d of databases) {
      if (this.open.has(d) || this.open.size >= cap) continue;
      const sql = postgres(urlForDatabase(config.databaseAdminUrl, d), {
        max: 1,
        idle_timeout: 0,
        max_lifetime: 0,
        onnotice: () => {},
        onclose: () => {
          if (this.open.get(d) === sql) this.open.delete(d);
        },
      });
      try {
        await sql.listen('scout_outbox', () => this.notified(d));
        this.open.set(d, sql);
      } catch (e) {
        log.warn({ err: errorText(e), database: d }, 'relay: could not listen on a workspace database, polling it');
        await sql.end({ timeout: 2 }).catch(() => {});
      }
    }
  }

  async closeAll(): Promise<void> {
    const all = [...this.open.values()];
    this.open.clear();
    await Promise.allSettled(all.map((sql) => sql.end({ timeout: 2 })));
  }
}

/** One outbox the relay reads: the control plane's or a workspace database's. */
export type OutboxSource = {
  name: string;
  /** Unsent rows, oldest first. */
  unsent(limit: number): Promise<OutboxRow[]>;
  markSent(ids: string[]): Promise<void>;
  /** Polled at most this often while it has nothing to send (workspace databases: no LISTEN there). */
  pollEveryMs?: number;
};

/**
 * How often an empty workspace outbox is polled. A notification (`WorkspaceListeners`) asks it at once;
 * the poll catches what a notification missed, and serves the databases past the listener cap.
 */
export const WORKSPACE_POLL_MS = 1000;

/** Per source: failures in a row and when to try it again. */
export type SourceHealth = Map<string, { failures: number; retryAt: number }>;

const SOURCE_BACKOFF_MS = 1000;
const SOURCE_BACKOFF_CAP_MS = 60_000;
/** Publishing failed in this many sources in a row: NATS is probably the problem, so the turn ends. */
const PUBLISH_FAILURES_TO_STOP = 3;

/** The outbox of one database. */
export function outboxSource(db: PlatformDatabase): OutboxSource {
  return {
    name: db.name,
    ...(db.control ? {} : { pollEveryMs: WORKSPACE_POLL_MS }),
    unsent: async (limit) =>
      (await db.admin.execute(
        sql`select seq, id, nats_subject, payload from platform.outbox where sent_at is null order by seq limit ${limit}`,
      )) as unknown as OutboxRow[],
    markSent: async (ids) => {
      await db.admin.execute(sql`update platform.outbox set sent_at = now() where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
    },
  };
}

/**
 * One relay turn: a batch from each source in turn (round-robin, so a busy database cannot starve the
 * others), oldest first within each, so each database's order holds. A source whose database fails is
 * logged and skipped, with a backoff doubling up to a minute, while the others go on. A row that will
 * not publish (no stream for its subject, too large) is that source's failure too, so one bad row holds
 * back only its own database. The turn ends, thrown once what was sent is marked, only when NATS itself
 * is down (`natsDown`) or publishing failed in `PUBLISH_FAILURES_TO_STOP` sources in a row.
 * `full`: some source had a full batch.
 */
export async function relayTurn(
  sources: OutboxSource[],
  health: SourceHealth,
  publish: (row: OutboxRow) => Promise<unknown>,
  opts: { batchSize: number; now?: number; stopped?: () => boolean; natsDown?: () => boolean; quiet?: Map<string, number> },
): Promise<{ sentAny: boolean; full: boolean }> {
  const now = opts.now ?? Date.now();
  let sentAny = false;
  let full = false;
  let publishFailuresInARow = 0;
  const failed = (src: OutboxSource, e: unknown) => {
    const failures = (health.get(src.name)?.failures ?? 0) + 1;
    const wait = Math.min(SOURCE_BACKOFF_CAP_MS, SOURCE_BACKOFF_MS * 2 ** (failures - 1));
    health.set(src.name, { failures, retryAt: now + wait });
    log.warn({ err: errorText(e), source: src.name, retryInMs: wait }, 'relay: could not read, publish or mark an outbox, skipping it');
  };
  for (const src of sources) {
    if (opts.stopped?.()) break;
    const h = health.get(src.name);
    if (h && h.retryAt > now) continue;
    if (src.pollEveryMs && (opts.quiet?.get(src.name) ?? -Infinity) > now) continue;
    let rows: OutboxRow[];
    try {
      rows = await src.unsent(opts.batchSize);
    } catch (e) {
      failed(src, e);
      continue;
    }
    if (rows.length >= opts.batchSize) full = true;
    if (src.pollEveryMs && rows.length === 0) opts.quiet?.set(src.name, now + src.pollEveryMs);
    else opts.quiet?.delete(src.name);
    const sent: string[] = [];
    let failure: unknown;
    for (const row of rows) {
      if (opts.stopped?.()) break;
      try {
        await publish(row);
        sent.push(row.id);
      } catch (e) {
        failure = e;
        break;
      }
    }
    if (sent.length > 0) {
      try {
        await src.markSent(sent);
        sentAny = true;
      } catch (e) {
        // Published but not marked: sent again later, and deduplicated by JetStream (msgID).
        failed(src, e);
        continue;
      }
    }
    if (failure) {
      publishFailuresInARow++;
      if (opts.natsDown?.() || publishFailuresInARow >= PUBLISH_FAILURES_TO_STOP) throw failure;
      failed(src, failure);
      continue;
    }
    if (sent.length > 0) publishFailuresInARow = 0;
    health.delete(src.name);
  }
  return { sentAny, full };
}

const LOCK_RETRY_MS = 2000;
const ERROR_RETRY_MS = 1000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Moves rows from every database's `platform.outbox` (`platformDatabases`: the control plane and each
 * workspace database) into JetStream, oldest first per database, one relay at a time (Postgres advisory
 * lock on the control plane, which also `LISTEN`s for new rows there; each workspace database is
 * `LISTEN`ed to on a connection of its own, and polled as well). Each message carries the envelope id as its NATS message id,
 * so a crash between publish and `sent_at` only causes a deduplicated re-publish.
 * Runs until `signal` aborts.
 */
export async function runRelay(opts: RelayOptions): Promise<void> {
  while (!opts.signal.aborted) {
    try {
      await relayWhileLocked(opts);
    } catch (e) {
      log.warn({ err: errorText(e) }, 'relay: stopped unexpectedly, restarting');
    }
    if (!opts.signal.aborted) {
      log.warn('relay: lost the lock, going back to waiting for it');
      await sleep(ERROR_RETRY_MS, opts.signal);
    }
  }
}

/** Holds the lock and relays until aborted or until the lock is lost (then returns). */
async function relayWhileLocked(opts: RelayOptions): Promise<void> {
  const { signal, batchSize = 100, idleMs = 200, natsUrl } = opts;
  let lost = false;
  let wake: (() => void) | undefined;
  // The lock is tied to this one session, so it must never be recycled: no max_lifetime, no idle_timeout.
  const lockSql = postgres(config.databaseAdminUrl, {
    max: 1,
    max_lifetime: 0, // 0 disables the timer
    idle_timeout: 0,
    onnotice: () => {},
    onclose: () => {
      lost = true;
      wake?.();
    },
  });
  const holdsLock = async (): Promise<boolean> => {
    if (lost) return false;
    try {
      const rows = await lockSql`select 1 from pg_locks where locktype = 'advisory' and granted and objid = hashtext('scout_relay')::oid and pid = pg_backend_pid()`;
      return rows.length > 0 && !lost;
    } catch {
      return false;
    }
  };
  let nats: Nats | undefined;
  let unlisten: (() => Promise<void>) | undefined;
  let stopListening: (() => Promise<void>) | undefined;
  let pendingWake = false;
  const poke = () => {
    pendingWake = true;
    wake?.();
  };
  const onAbort = () => wake?.();
  signal.addEventListener('abort', onAbort);

  try {
    // 1. Single active relay: hold the advisory lock on this session.
    while (!signal.aborted) {
      try {
        const [r] = await lockSql`select pg_try_advisory_lock(hashtext('scout_relay')) as ok`;
        if (r?.ok) {
          lost = false;
          break;
        }
      } catch (e) {
        log.warn({ err: errorText(e) }, 'relay: could not ask for the lock');
      }
      await sleep(LOCK_RETRY_MS, signal);
    }
    if (signal.aborted) return;
    log.info('relay: lock acquired');

    // 2. Wake early when something is inserted.
    const listener = await lockSql.listen('scout_outbox', poke);
    unlisten = () => listener.unlisten();

    // 3. Connect (retries forever) and make sure the streams exist.
    const connecting = connectNats(natsUrl);
    const connected = await Promise.race([
      connecting,
      new Promise<undefined>((res) => signal.addEventListener('abort', () => res(undefined), { once: true })),
    ]);
    if (!connected) {
      void connecting.then((n) => n.nc.close()).catch(() => {});
      return;
    }
    nats = connected;
    let streamsReady = false;
    const health: SourceHealth = new Map();
    const quiet = new Map<string, number>();
    const js = nats.js;
    // A notification from a workspace database: ask its outbox now, not after its poll wait.
    const listeners = new WorkspaceListeners((database) => {
      quiet.delete(database);
      poke();
    });
    stopListening = () => listeners.closeAll();

    while (!signal.aborted) {
      if (!(await holdsLock())) return;
      let sentAny = false;
      let full = false;
      try {
        if (!streamsReady) {
          await ensureStreams(nats.jsm);
          streamsReady = true;
        }
        const databases = await platformDatabases({ relay: true });
        await listeners.sync(databases.filter((d) => !d.control).map((d) => d.name), config.relayPoolCap);
        const sources = databases.map(outboxSource);
        ({ sentAny, full } = await relayTurn(
          sources,
          health,
          (row) => js.publish(row.nats_subject, JSON.stringify(row.payload), { msgID: row.id }),
          { batchSize, stopped: () => signal.aborted || lost, natsDown: () => nats!.nc.isClosed(), quiet },
        ));
      } catch (e) {
        log.warn({ err: errorText(e) }, 'relay: publish failed, retrying');
        streamsReady = false;
        await sleep(ERROR_RETRY_MS, signal);
        continue;
      }
      if (sentAny && full) continue;
      if (pendingWake) {
        pendingWake = false;
        continue;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, idleMs);
        function done() {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        }
        wake = done;
      });
      pendingWake = false;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await unlisten?.().catch(() => {});
    await stopListening?.().catch(() => {});
    await nats?.nc.drain().catch(() => {});
    await lockSql.end({ timeout: 2 }).catch(() => {});
  }
}

/** Age in milliseconds of the oldest unsent outbox row, 0 when none. */
export async function relayLagMs(db: Pick<typeof controlAdminDb, 'execute'> = controlAdminDb): Promise<number> {
  const rows = await db.execute(
    sql`select coalesce(extract(epoch from (clock_timestamp() - min(created_at))) * 1000, 0)::float8 as lag from platform.outbox where sent_at is null`,
  );
  return Math.max(0, Math.round(Number((rows[0] as { lag: number | string }).lag)));
}
