import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import type { ModuleContext } from '@/platform/context';
import { adminDb, closeDbs } from '@/platform/db/client';
import { withTenant } from '@/platform/db/tenant';
import { publish } from '@/platform/events/outbox';
import { defineEvent } from '@/platform/events/registry';
import { newId } from '@/platform/ids';
import { connectNats } from '@/platform/nats/connection';
import { ensureStreams } from '@/platform/nats/streams';
import { relayLagMs, runRelay } from '@/platform/relay';

const memberAdded = defineEvent('tenancy.member.added', 1, z.object({ n: z.number() }));

let nc: NatsConnection;
let js: JetStreamClient;
let jsm: JetStreamManager;

beforeAll(async () => {
  ({ nc, js, jsm } = await connectNats());
  await ensureStreams(jsm);
});
afterAll(async () => {
  await nc.drain();
  await closeDbs();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => Promise<boolean> | boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting');
}

const ctxOf = (tenantId: string, tx: ModuleContext['tx']): ModuleContext => ({
  tenantId,
  actor: { kind: 'system', id: 'system' },
  correlationId: 'cor_test',
  tx,
});
const emit = (tenantId: string, n: number) =>
  withTenant(tenantId, (tx) => publish(ctxOf(tenantId, tx), memberAdded, { n }));

function startRelay(opts: { natsUrl?: string } = {}) {
  const ac = new AbortController();
  const done = runRelay({ signal: ac.signal, ...opts });
  return {
    stop: async () => {
      ac.abort();
      await done;
    },
  };
}

type Got = { id: string; n: number; at: number };
/** Ordered consumer on one tenant's events, from the beginning. */
async function listen(client: JetStreamClient, tenantId: string, got: Got[]) {
  const c = await client.consumers.get('SCOUT_EVENTS', { filter_subjects: [`scout.${tenantId}.>`] });
  const messages = await c.consume();
  void (async () => {
    for await (const m of messages) {
      const env = m.json<{ id: string; data: { n: number } }>();
      got.push({ id: env.id, n: env.data.n, at: Date.now() });
    }
  })();
  return async () => {
    await messages.close();
  };
}

const unsentCount = async () =>
  ((await adminDb.execute(sql`select count(*)::int as n from platform.outbox where sent_at is null`))[0] as { n: number }).n;
const clear = () => adminDb.execute(sql`delete from platform.outbox`);
const lockCount = async () =>
  (
    (
      await adminDb.execute(
        sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted and objid = hashtext('scout_relay')::oid`,
      )
    )[0] as { n: number }
  ).n;

describe('relay', () => {
  it('delivers 100 events from one transaction in order within 2 seconds', async () => {
    await clear();
    const t = newId('t');
    const got: Got[] = [];
    const stopListen = await listen(js, t, got);
    const relay = startRelay();
    try {
      await sleep(300); // let the relay take the lock and connect
      await withTenant(t, async (tx) => {
        for (let i = 0; i < 100; i++) await publish(ctxOf(t, tx), memberAdded, { n: i });
      });
      await waitFor(() => got.length >= 100, 2000);
      expect(got.map((g) => g.n)).toEqual(Array.from({ length: 100 }, (_, i) => i));
      await waitFor(async () => (await unsentCount()) === 0);
    } finally {
      await relay.stop();
      await stopListen();
    }
  });

  it('p95 commit to receive is under 1 second at 50 events per second (PLT-E1-S2-AC2)', async () => {
    await clear();
    const t = newId('t');
    const got: Got[] = [];
    const stopListen = await listen(js, t, got);
    const relay = startRelay();
    const committed = new Map<number, number>();
    try {
      await sleep(300);
      const total = 500;
      const startedAt = Date.now();
      const pending: Promise<void>[] = [];
      for (let i = 0; i < total; i++) {
        await sleep(Math.max(0, startedAt + i * 20 - Date.now()));
        pending.push(emit(t, i).then(() => void committed.set(i, Date.now())));
      }
      await Promise.all(pending);
      await waitFor(() => got.length >= total, 10000);
      const lat = got.map((g) => g.at - (committed.get(g.n) as number)).sort((a, b) => a - b);
      const p95 = lat[Math.floor(lat.length * 0.95)] as number;
      expect(p95).toBeLessThan(1000);
    } finally {
      await relay.stop();
      await stopListen();
    }
  }, 40000);

  it('only one of two relays holds the lock and every event arrives once (PLT-E1-S2-AC1, AC3)', async () => {
    await clear();
    const t = newId('t');
    const got: Got[] = [];
    const stopListen = await listen(js, t, got);
    const a = startRelay();
    const b = startRelay();
    try {
      await waitFor(async () => (await lockCount()) >= 1);
      await sleep(500);
      expect(await lockCount()).toBe(1);
      for (let i = 0; i < 30; i++) await emit(t, i);
      await waitFor(() => got.length >= 30);
      await sleep(500);
      expect(got.map((g) => g.n)).toEqual(Array.from({ length: 30 }, (_, i) => i));
      expect(new Set(got.map((g) => g.id)).size).toBe(30);
    } finally {
      await a.stop();
      await b.stop();
      await stopListen();
    }
  }, 30000);

  it('hands over when the active relay loses its lock connection, with no loss or duplicates', async () => {
    await clear();
    const t = newId('t');
    const got: Got[] = [];
    const stopListen = await listen(js, t, got);
    const a = startRelay();
    try {
      await waitFor(async () => (await lockCount()) === 1);
      const b = startRelay();
      try {
        for (let i = 0; i < 10; i++) await emit(t, i);
        await waitFor(() => got.length >= 10);
        // Kill the backend that holds the lock (the active relay's lock session).
        await adminDb.execute(
          sql`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and granted and objid = hashtext('scout_relay')::oid`,
        );
        // The standby takes over (within its 2 second retry) while events keep coming.
        for (let i = 10; i < 40; i++) {
          await emit(t, i);
          await sleep(100);
        }
        await waitFor(() => got.length >= 40, 15000);
        await sleep(500);
        expect(await lockCount()).toBe(1);
        expect(got.map((g) => g.n)).toEqual(Array.from({ length: 40 }, (_, i) => i));
        expect(new Set(got.map((g) => g.id)).size).toBe(40);
      } finally {
        await b.stop();
      }
    } finally {
      await a.stop();
      await stopListen();
    }
  }, 40000);

  it('does not add stream messages when sent rows are replayed (dedupe by msgID)', async () => {
    await clear();
    const t = newId('t');
    const first = startRelay();
    for (let i = 0; i < 5; i++) await emit(t, i);
    await waitFor(async () => (await unsentCount()) === 0);
    await first.stop();
    const before = (await jsm.streams.info('SCOUT_EVENTS')).state.messages;
    await adminDb.execute(sql`update platform.outbox set sent_at = null`);
    const second = startRelay();
    await waitFor(async () => (await unsentCount()) === 0);
    await second.stop();
    expect((await jsm.streams.info('SCOUT_EVENTS')).state.messages).toBe(before);
  });

  it('reports lag for the oldest unsent row', async () => {
    await clear();
    expect(await relayLagMs()).toBe(0);
    await emit(newId('t'), 1);
    await sleep(50);
    expect(await relayLagMs()).toBeGreaterThanOrEqual(40);
  });
});

describe('relay with NATS down', () => {
  const exe = process.platform === 'win32' ? 'nats-server.exe' : 'nats-server';
  const bin = path.resolve('.tools', 'nats-server', exe);
  const port = 4333;
  const url = `nats://127.0.0.1:${port}`;
  let dir: string;
  let proc: ChildProcess | undefined;

  const startServer = async () => {
    proc = spawn(bin, ['-js', '-sd', dir, '-p', String(port)], { stdio: 'ignore' });
    await waitFor(async () => {
      try {
        const c = await connect({ servers: url });
        await c.close();
        return true;
      } catch {
        return false;
      }
    }, 15000);
  };
  const stopServer = async () => {
    const p = proc;
    proc = undefined;
    if (!p) return;
    const exited = new Promise((r) => p.once('exit', r));
    p.kill();
    await exited;
  };

  afterAll(async () => {
    await stopServer();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps publishes working, then delivers them in order exactly once after NATS returns', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'scout-nats-'));
    await clear();
    await startServer();
    const t = newId('t');
    const side = await connectNats(url);
    await ensureStreams(side.jsm);
    const relay = startRelay({ natsUrl: url });
    try {
      await emit(t, 0);
      await waitFor(async () => (await unsentCount()) === 0);

      await stopServer();
      for (let i = 1; i <= 5; i++) await emit(t, i); // succeeds: the outbox is in Postgres
      await sleep(1500);
      expect(await unsentCount()).toBe(5);

      await startServer();
      await waitFor(async () => (await unsentCount()) === 0, 20000);

      const got: Got[] = [];
      const check = await connectNats(url);
      const stopListen = await listen(check.js, t, got);
      await waitFor(() => got.length >= 6);
      await sleep(500);
      expect(got.map((g) => g.n)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(new Set(got.map((g) => g.id)).size).toBe(6);
      await stopListen();
      await check.nc.close();
    } finally {
      await relay.stop();
      await side.nc.close().catch(() => {});
    }
  }, 60000);
});
