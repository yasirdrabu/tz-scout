import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Nats } from '@/platform/nats/connection';
import { adminDb, closeDbs } from '@/platform/db/client';
import type { Envelope } from '@/platform/events/envelope';
import { defineEvent } from '@/platform/events/registry';
import { newId } from '@/platform/ids';
import { connectNats } from '@/platform/nats/connection';
import { ensureStreams } from '@/platform/nats/streams';
import { eventSubject } from '@/platform/nats/subjects';
import { defineConsumer, durableName, type ConsumerDef } from '@/platform/runtime/consumers';
import { startWorker, type AckInfo, type WorkerOptions } from '@/platform/runtime/worker';
import { sleep, waitFor } from '../helpers/wait';

const touched = defineEvent('accounts.account.touched', 1, z.object({ accountId: z.string() }));
const ordered = defineEvent('accounts.account.reordered', 1, z.object({ accountId: z.string() }));

let nats: Nats;
const created: ConsumerDef[] = [];

beforeAll(async () => {
  nats = await connectNats();
  await ensureStreams(nats.jsm);
  await adminDb.execute(
    sql`create table if not exists platform.t6_counter (key text primary key, n int not null)`,
  );
  await adminDb.execute(sql`grant select, insert, update, delete on platform.t6_counter to scout_app`);
});
afterAll(async () => {
  for (const c of created) await nats.jsm.consumers.delete('SCOUT_EVENTS', durableName(c)).catch(() => {});
  await nats.nc.drain();
  await closeDbs();
});

function envelopeOf<D>(type: string, tenantId: string, data: D): Envelope<D> {
  return {
    id: newId('evt'),
    type,
    schemaVersion: 1,
    tenantId,
    occurredAt: new Date().toISOString(),
    actor: { kind: 'system', id: 'system' },
    correlationId: newId('cor'),
    data,
  };
}

/** Publishes straight to JetStream. A fresh msgID each time, so the stream keeps duplicates. */
async function deliver(e: Envelope<unknown>): Promise<void> {
  await nats.js.publish(eventSubject(e.tenantId, e.type), JSON.stringify(e), { msgID: newId('evt') });
}

function start(opts: Omit<WorkerOptions, 'signal' | 'onReady'>) {
  const ac = new AbortController();
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  const done = startWorker({ ...opts, signal: ac.signal, onReady: ready });
  return {
    ready: readyP,
    abort: () => ac.abort(),
    stop: async () => {
      ac.abort();
      await done;
    },
    done,
  };
}

const counter = async (key: string) =>
  ((await adminDb.execute(sql`select n from platform.t6_counter where key = ${key}`))[0] as { n: number } | undefined)?.n ?? 0;

function counterConsumer(name: string, timeoutMs?: number) {
  const c = defineConsumer({
    name,
    event: touched,
    ...(timeoutMs ? { timeoutMs } : {}),
    handle: async (e, ctx) => {
      await ctx.tx.execute(
        sql`insert into platform.t6_counter (key, n) values (${e.tenantId + ':' + e.data.accountId}, 1)
            on conflict (key) do update set n = platform.t6_counter.n + 1`,
      );
    },
  });
  created.push(c);
  return c;
}

describe('consumers', () => {
  it('changes data once when the same envelope arrives twice (PLT-E1-S3-AC1)', async () => {
    const c = counterConsumer(`test.counter_${newId('run').slice(4)}`);
    const seen: AckInfo[] = [];
    const w = start({ consumers: [c], hooks: { beforeAck: (i) => void seen.push(i) } });
    try {
      await w.ready;
      const t = newId('t');
      const e = envelopeOf('accounts.account.touched', t, { accountId: 'acc_1' });
      await deliver(e);
      await deliver(e);
      await waitFor(() => seen.length >= 2);
      await sleep(200);
      expect(await counter(`${t}:acc_1`)).toBe(1);
      expect(seen.map((s) => s.outcome).sort()).toEqual(['duplicate', 'handled']);
    } finally {
      await w.stop();
    }
  });

  it('a handler that committed but was never acked changes nothing on redelivery (Review Focus 3)', async () => {
    const c = counterConsumer(`test.noack_${newId('run').slice(4)}`, 1000);
    const t = newId('t');
    const e = envelopeOf('accounts.account.touched', t, { accountId: 'acc_2' });

    // First worker: commits, then dies before it can ack.
    const first = start({
      consumers: [c],
      hooks: {
        beforeAck: (i) => {
          if (i.envelope.id !== e.id) return;
          first.abort();
          return false; // skip the ack, as if the process was killed here
        },
      },
    });
    await first.ready;
    await deliver(e);
    await first.done;
    expect(await counter(`${t}:acc_2`)).toBe(1);

    // Second worker on the same durable consumer gets the redelivery after ack_wait.
    const seen: AckInfo[] = [];
    const second = start({ consumers: [c], hooks: { beforeAck: (i) => void seen.push(i) } });
    try {
      await second.ready;
      await waitFor(() => seen.some((s) => s.envelope.id === e.id), 10000);
      const redelivery = seen.find((s) => s.envelope.id === e.id) as AckInfo;
      expect(redelivery.deliveryCount).toBeGreaterThanOrEqual(2);
      expect(redelivery.outcome).toBe('duplicate');
      expect(await counter(`${t}:acc_2`)).toBe(1);
    } finally {
      await second.stop();
    }
  });

  it('never runs two events for the same key at once; different keys run in parallel (PLT-E1-S3-AC2)', async () => {
    const runs: { accountId: string; start: number; end: number }[] = [];
    const c = defineConsumer({
      name: `test.ordered_${newId('run').slice(4)}`,
      event: ordered,
      orderedBy: (e) => e.data.accountId,
      handle: async (e) => {
        const start = Date.now();
        await sleep(300);
        runs.push({ accountId: e.data.accountId, start, end: Date.now() });
      },
    });
    created.push(c);
    const w = start({ consumers: [c] });
    try {
      await w.ready;
      const t = newId('t');
      for (const accountId of ['same', 'same', 'b1', 'b2']) {
        await deliver(envelopeOf('accounts.account.reordered', t, { accountId }));
      }
      await waitFor(() => runs.length >= 4, 10000);
      const overlap = (a: (typeof runs)[number], b: (typeof runs)[number]) => a.start < b.end && b.start < a.end;
      const [s1, s2] = runs.filter((r) => r.accountId === 'same') as [(typeof runs)[number], (typeof runs)[number]];
      expect(overlap(s1, s2)).toBe(false);
      const b1 = runs.find((r) => r.accountId === 'b1') as (typeof runs)[number];
      const b2 = runs.find((r) => r.accountId === 'b2') as (typeof runs)[number];
      expect(overlap(b1, b2)).toBe(true);
    } finally {
      await w.stop();
    }
  });

  it('sets causationId to the event id and passes the tenant and correlation id', async () => {
    let got: { tenantId: string; correlationId: string; causationId?: string } | undefined;
    const c = defineConsumer({
      name: `test.ctx_${newId('run').slice(4)}`,
      event: touched,
      handle: async (_e, ctx) => {
        got = { tenantId: ctx.tenantId, correlationId: ctx.correlationId, causationId: ctx.causationId };
      },
    });
    created.push(c);
    const w = start({ consumers: [c] });
    try {
      await w.ready;
      const e = envelopeOf('accounts.account.touched', newId('t'), { accountId: 'acc_3' });
      await deliver(e);
      await waitFor(() => got !== undefined);
      expect(got).toEqual({ tenantId: e.tenantId, correlationId: e.correlationId, causationId: e.id });
    } finally {
      await w.stop();
    }
  });
});
