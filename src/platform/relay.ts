import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { config } from '@/platform/config';
import { adminDb } from '@/platform/db/client';
import { log } from '@/platform/log';
import { connectNats, type Nats } from '@/platform/nats/connection';
import { ensureStreams } from '@/platform/nats/streams';

export type RelayOptions = {
  signal: AbortSignal;
  batchSize?: number;
  idleMs?: number;
  /** Defaults to NATS_URL. */
  natsUrl?: string;
};

type Row = { seq: number; id: string; nats_subject: string; payload: unknown };

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
 * Moves rows from `platform.outbox` into JetStream, oldest first, one relay at a time
 * (Postgres advisory lock). Each message carries the envelope id as its NATS message id,
 * so a crash between publish and `sent_at` only causes a deduplicated re-publish.
 * Runs until `signal` aborts.
 */
export async function runRelay(opts: RelayOptions): Promise<void> {
  while (!opts.signal.aborted) {
    try {
      await relayWhileLocked(opts);
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'relay: stopped unexpectedly, restarting');
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
        log.warn({ err: (e as Error).message }, 'relay: could not ask for the lock');
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

    while (!signal.aborted) {
      if (!(await holdsLock())) return;
      let sentAny = false;
      let full = false;
      try {
        if (!streamsReady) {
          await ensureStreams(nats.jsm);
          streamsReady = true;
        }
        const rows = (await adminDb.execute(
          sql`select seq, id, nats_subject, payload from platform.outbox where sent_at is null order by seq limit ${batchSize}`,
        )) as unknown as Row[];
        full = rows.length >= batchSize;
        const sent: string[] = [];
        let failure: unknown;
        for (const row of rows) {
          if (signal.aborted || lost) break;
          try {
            await nats.js.publish(row.nats_subject, JSON.stringify(row.payload), { msgID: row.id });
            sent.push(row.id);
          } catch (e) {
            failure = e;
            break;
          }
        }
        if (sent.length > 0) {
          await adminDb.execute(sql`update platform.outbox set sent_at = now() where id in (${sql.join(sent.map((id) => sql`${id}`), sql`, `)})`);
          sentAny = true;
        }
        if (failure) throw failure;
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'relay: publish failed, retrying');
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
    await nats?.nc.drain().catch(() => {});
    await lockSql.end({ timeout: 2 }).catch(() => {});
  }
}

/** Age in milliseconds of the oldest unsent outbox row, 0 when none. */
export async function relayLagMs(): Promise<number> {
  const rows = await adminDb.execute(
    sql`select coalesce(extract(epoch from (clock_timestamp() - min(created_at))) * 1000, 0)::float8 as lag from platform.outbox where sent_at is null`,
  );
  return Math.max(0, Math.round(Number((rows[0] as { lag: number | string }).lag)));
}
