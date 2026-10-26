import {
  AckPolicy,
  DeliverPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  type JetStreamManager,
  type JsMsg,
} from '@nats-io/jetstream';
import { sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { config } from '../config';
import type { ModuleContext } from '../context';
import { withTenant } from '../db/tenant';
import { recordDeadJob } from '../dead-jobs';
import { EnvelopeSchema, type Envelope } from '../events/envelope';
import { log, logFor } from '../log';
import { connectNats, type Nats } from '../nats/connection';
import { ensureStreams } from '../nats/streams';
import { durableName, type ConsumerDef } from './consumers';
import {
  backoffFor,
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_DELIVER,
  DEFAULT_TIMEOUT_MS,
  type JobHandlerDef,
} from './jobs';

/** What happened to a message just before it is acked. */
export type AckInfo = {
  /** `processed_event` consumer name: the consumer name, or `jobs.<job name>`. */
  name: string;
  envelope: Envelope;
  deliveryCount: number;
  outcome: 'handled' | 'duplicate';
};

export type WorkerOptions = {
  consumers?: ConsumerDef[];
  jobs?: JobHandlerDef[];
  signal: AbortSignal;
  /** Defaults to NATS_URL. */
  natsUrl?: string;
  /** Messages handled at once per consumer or job. Default 8. */
  concurrency?: number;
  /**
   * Messages handled at once across the whole worker. Each holds one appDb connection, so the
   * default is DATABASE_POOL_MAX minus 2 (headroom for other queries in the process).
   */
  maxInFlight?: number;
  /** How long a message waits on a processed_event row another delivery holds. Default 2000. */
  busyLockTimeoutMs?: number;
  /** Delay before a message put back because it was busy comes again. Default 1000. */
  busyRetryMs?: number;
  /** Called once every durable consumer exists and is being consumed. */
  onReady?: () => void;
  /** Test hooks. `beforeAck` returning false skips the ack (simulates a crash after commit). */
  hooks?: { beforeAck?: (info: AckInfo) => boolean | void | Promise<boolean | void> };
};

/** One durable JetStream consumer and how to handle its messages. */
type Sub = {
  kind: 'consumer' | 'job';
  /** Name in `processed_event`. */
  processedName: string;
  /** Name in `dead_job.consumer_or_job` and `platform.job.dead.jobType`. */
  deadName: string;
  durable: string;
  stream: 'SCOUT_EVENTS' | 'SCOUT_JOBS';
  filter: string;
  deliverPolicy: DeliverPolicy;
  maxDeliver: number;
  backoffMs: number[];
  timeoutMs: number;
  parse: (data: unknown) => unknown;
  orderedBy?: (e: Envelope) => string;
  handle: (e: Envelope, ctx: ModuleContext) => Promise<void>;
};

const ERROR_MAX = 4000;

/** Give up now: dead-letter without further retries. */
class Permanent extends Error {}
/** Another delivery holds the same processed_event row or ordering key: put back, try later. */
class Busy extends Error {}
class TimedOut extends Error {
  override name = 'TimedOut';
}

const LOCK_NOT_AVAILABLE = '55P03';

function pgCode(e: unknown): string | undefined {
  for (let c: unknown = e; c && typeof c === 'object'; c = (c as { cause?: unknown }).cause) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Awaits `stmt`; a lock wait past lock_timeout becomes Busy. */
async function orBusy<T>(stmt: Promise<T>): Promise<T> {
  try {
    return await stmt;
  } catch (e) {
    if (pgCode(e) === LOCK_NOT_AVAILABLE) throw new Busy('busy');
    throw e;
  }
}

/** Rejects with TimedOut after `ms`. The handler may keep running, but its transaction is rolled back. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  p.catch(() => {}); // a late rejection after the timeout must not become unhandled
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimedOut(`The handler did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

class Semaphore {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free++;
  }
}

type Runtime = {
  hooks: WorkerOptions['hooks'];
  slots: Semaphore;
  busyLockTimeoutMs: number;
  busyRetryMs: number;
};

function fromConsumer(c: ConsumerDef): Sub {
  return {
    kind: 'consumer',
    processedName: c.name,
    deadName: c.name,
    durable: durableName(c),
    stream: 'SCOUT_EVENTS',
    filter: `scout.*.${c.event.type}`,
    // A new consumer starts with events published after it is created, not 90 days of history.
    deliverPolicy: DeliverPolicy.New,
    maxDeliver: c.opts.maxDeliver ?? DEFAULT_MAX_DELIVER,
    backoffMs: c.opts.backoffMs ?? DEFAULT_BACKOFF_MS,
    timeoutMs: c.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    parse: (d) => c.event.data.parse(d),
    orderedBy: c.orderedBy?.bind(c),
    handle: c.handle.bind(c),
  };
}

function fromJob(j: JobHandlerDef): Sub {
  return {
    kind: 'job',
    processedName: `jobs.${j.name}`,
    deadName: j.name,
    durable: durableName(j),
    stream: 'SCOUT_JOBS',
    filter: `scout.*.jobs.${j.name}`,
    deliverPolicy: DeliverPolicy.All,
    maxDeliver: j.job.opts.maxDeliver ?? DEFAULT_MAX_DELIVER,
    backoffMs: j.job.opts.backoffMs ?? DEFAULT_BACKOFF_MS,
    timeoutMs: j.job.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    parse: (d) => j.job.data.parse(d),
    handle: j.handle.bind(j),
  };
}

const ms2ns = (ms: number) => ms * 1_000_000;

/** Creates the durable consumer, or updates the fields that may change between releases. */
async function ensureConsumer(jsm: JetStreamManager, s: Sub): Promise<void> {
  let exists = true;
  try {
    await jsm.consumers.info(s.stream, s.durable);
  } catch (e) {
    if (e instanceof JetStreamApiError && e.code === JetStreamApiCodes.ConsumerNotFound) exists = false;
    else throw e;
  }
  // max_deliver is unlimited on the server: the worker decides when to give up, so the last
  // attempt always lands in dead_job (also when it ran past ack_wait).
  const shared = { ack_wait: ms2ns(s.timeoutMs), filter_subject: s.filter, max_deliver: -1 };
  if (exists) await jsm.consumers.update(s.stream, s.durable, shared);
  else {
    await jsm.consumers.add(s.stream, {
      ...shared,
      durable_name: s.durable,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: s.deliverPolicy,
    });
  }
}

function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e).slice(0, ERROR_MAX);
  let text = `${e.name === 'Error' ? '' : e.name + ': '}${e.message}`;
  // Drizzle wraps database errors; the cause carries the reason (for example a statement timeout).
  if (e.cause instanceof Error) text += ` (${e.cause.message})`;
  return text.slice(0, ERROR_MAX);
}

/**
 * Handles one delivery: dedupe, optional per-key lock, handler under a time limit, commit, ack.
 * Every wait is bounded, so a slow or stuck delivery holds its slot and connection for at most
 * busyLockTimeoutMs + the per-key wait + timeoutMs.
 */
async function processMessage(m: JsMsg, s: Sub, rt: Runtime): Promise<void> {
  let envelope: Envelope;
  try {
    envelope = EnvelopeSchema.parse(m.json()) as Envelope;
  } catch (e) {
    // No tenant to store it under; nothing will make it valid later.
    log.error({ consumer: s.processedName, subject: m.subject, err: errorText(e) }, 'worker: invalid envelope, dropped');
    m.term('invalid envelope');
    return;
  }
  const deliveryCount = m.info.deliveryCount;
  const lg = logFor(envelope).child({ consumer: s.processedName, eventId: envelope.id, deliveryCount });
  const setLocal = (name: string, value: string) => sql`select set_config(${name}, ${value}, true)`;
  try {
    const outcome = await withTenant(envelope.tenantId, async (tx) => {
      // A delivery still running elsewhere holds this row uncommitted: do not wait on it for long.
      await tx.execute(setLocal('lock_timeout', `${rt.busyLockTimeoutMs}ms`));
      const inserted = await orBusy(
        tx.execute(
          sql`insert into platform.processed_event (consumer_name, event_id) values (${s.processedName}, ${envelope.id})
              on conflict do nothing returning 1`,
        ),
      );
      if (inserted.length === 0) return 'duplicate' as const;
      if (deliveryCount > s.maxDeliver) {
        throw new Permanent(`Gave up after ${deliveryCount - 1} deliveries: the last ones did not finish in time`);
      }
      let data: unknown;
      try {
        data = s.parse(envelope.data);
      } catch (e) {
        if (e instanceof ZodError) throw new Permanent(`Invalid data: ${errorText(e)}`);
        throw e;
      }
      const typed: Envelope = { ...envelope, data };
      if (s.orderedBy) {
        // Same key: one at a time (mutual exclusion, not ordering). The holder is done within
        // timeoutMs, so wait about that long, then put the message back.
        await tx.execute(setLocal('lock_timeout', `${s.timeoutMs + rt.busyLockTimeoutMs}ms`));
        const key = `${s.processedName}:${s.orderedBy(typed)}`;
        await orBusy(tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`));
      }
      // The handler's own statements are bounded by the same time limit as the handler.
      await tx.execute(setLocal('lock_timeout', '0'));
      await tx.execute(setLocal('statement_timeout', `${s.timeoutMs}ms`));
      await withTimeout(
        s.handle(typed, {
          tenantId: envelope.tenantId,
          actor: envelope.actor,
          correlationId: envelope.correlationId,
          causationId: envelope.id,
          tx,
        }),
        s.timeoutMs,
      );
      return 'handled' as const;
    });
    if (rt.hooks?.beforeAck && (await rt.hooks.beforeAck({ name: s.processedName, envelope, deliveryCount, outcome })) === false) {
      return;
    }
    m.ack();
    if (outcome === 'duplicate') lg.debug('worker: already processed, skipped');
  } catch (e) {
    if (e instanceof Busy) {
      lg.info({ retryInMs: rt.busyRetryMs }, 'worker: another delivery holds this message or key, put back');
      m.nak(rt.busyRetryMs);
      return;
    }
    const error = errorText(e);
    if (deliveryCount < s.maxDeliver && !(e instanceof Permanent)) {
      const delay = backoffFor(s.backoffMs, deliveryCount);
      lg.warn({ err: error, retryInMs: delay }, 'worker: handler failed, will retry');
      m.nak(delay);
      return;
    }
    try {
      await recordDeadJob({ name: s.deadName, envelope, error, attempts: deliveryCount });
      m.term(error.slice(0, 200));
      lg.error({ err: error }, 'worker: gave up, stored as a dead job');
    } catch (e2) {
      lg.error({ err: error, deadLetterErr: errorText(e2) }, 'worker: could not store dead job, will retry');
      m.nak(backoffFor(s.backoffMs, deliveryCount));
    }
  }
}

/** Consumes one durable consumer until stopped, `concurrency` messages at a time. */
async function runSub(nats: Nats, s: Sub, opts: WorkerOptions, rt: Runtime): Promise<() => Promise<void>> {
  const concurrency = opts.concurrency ?? 8;
  const consumer = await nats.js.consumers.get(s.stream, s.durable);
  const messages = await consumer.consume({ max_messages: concurrency });
  const inFlight = new Set<Promise<void>>();
  const heartbeatMs = Math.max(50, Math.min(Math.floor(s.timeoutMs / 3), 10_000));
  const loop = (async () => {
    for await (const m of messages) {
      // Keep the delivery ours while it waits for a slot and runs; every step is time-bounded.
      const heartbeat = setInterval(() => m.working(), heartbeatMs);
      while (inFlight.size >= concurrency) await Promise.race(inFlight);
      const p: Promise<void> = (async () => {
        await rt.slots.acquire();
        try {
          await processMessage(m, s, rt);
        } finally {
          rt.slots.release();
        }
      })()
        .catch((e) => log.error({ consumer: s.processedName, err: errorText(e) }, 'worker: unexpected error'))
        .finally(() => {
          clearInterval(heartbeat);
          inFlight.delete(p);
        });
      inFlight.add(p);
    }
  })();
  return async () => {
    await messages.close().catch(() => {});
    await loop.catch(() => {});
    await Promise.allSettled([...inFlight]);
  };
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Runs consumers and job handlers: one durable JetStream consumer each. A message is handled
 * once per consumer (`processed_event` in the handler's transaction), retried with backoff on
 * error, and stored in `dead_job` after its last attempt. Resolves after `signal` aborts and
 * in-flight messages finish.
 */
export async function startWorker(opts: WorkerOptions): Promise<void> {
  const subs = [
    ...(opts.consumers ?? []).map(fromConsumer),
    ...(opts.jobs ?? []).map(fromJob),
  ];
  const durables = new Set<string>();
  for (const s of subs) {
    if (durables.has(`${s.stream}/${s.durable}`)) throw new Error(`Two handlers share the consumer name ${s.durable}`);
    durables.add(`${s.stream}/${s.durable}`);
  }

  const { signal } = opts;
  const connecting = connectNats(opts.natsUrl);
  const nats = await Promise.race([connecting, aborted(signal).then(() => undefined)]);
  if (!nats) {
    void connecting.then((n) => n.nc.close()).catch(() => {});
    return;
  }
  const stops: (() => Promise<void>)[] = [];
  try {
    await ensureStreams(nats.jsm);
    for (const s of subs) await ensureConsumer(nats.jsm, s);
    const rt: Runtime = {
      hooks: opts.hooks,
      slots: new Semaphore(Math.max(1, opts.maxInFlight ?? config.databasePoolMax - 2)),
      busyLockTimeoutMs: opts.busyLockTimeoutMs ?? 2000,
      busyRetryMs: opts.busyRetryMs ?? 1000,
    };
    for (const s of subs) stops.push(await runSub(nats, s, opts, rt));
    log.info({ consumers: subs.map((s) => s.durable) }, 'worker: consuming');
    opts.onReady?.();
    await aborted(signal);
  } finally {
    await Promise.allSettled(stops.map((stop) => stop()));
    await nats.nc.drain().catch(() => {});
  }
}
