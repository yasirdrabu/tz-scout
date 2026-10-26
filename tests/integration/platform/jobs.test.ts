import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ModuleContext } from '@/platform/context';
import { adminDb, closeDbs } from '@/platform/db/client';
import { withTenant } from '@/platform/db/tenant';
import { discardDeadJob, listDeadJobs, retryDeadJob } from '@/platform/dead-jobs';
import { pingHandler, pingResult, sendPing } from '@/platform/diagnostics';
import type { Envelope } from '@/platform/events/envelope';
import { enqueueJob } from '@/platform/events/outbox';
import { defineJob } from '@/platform/events/registry';
import { newId } from '@/platform/ids';
import { connectNats, type Nats } from '@/platform/nats/connection';
import { ensureStreams } from '@/platform/nats/streams';
import { runRelay } from '@/platform/relay';
import { defineJobHandler, type JobHandlerDef } from '@/platform/runtime/jobs';
import { startWorker } from '@/platform/runtime/worker';
import { waitFor } from '../helpers/wait';

const alwaysFails = defineJob('test.always_fails', z.object({ n: z.number() }), { maxDeliver: 3, backoffMs: [50, 50] });
const flaky = defineJob('test.flaky', z.object({ n: z.number() }), { maxDeliver: 2, backoffMs: [50] });
const discardable = defineJob('test.discardable', z.object({ n: z.number() }), { maxDeliver: 1 });

let nats: Nats;
let relayAc: AbortController;
let relayDone: Promise<void>;

beforeAll(async () => {
  nats = await connectNats();
  await ensureStreams(nats.jsm);
  // Leftovers from earlier runs of this file (the stream outlives the test database).
  await nats.jsm.streams.purge('SCOUT_JOBS', { filter: 'scout.*.jobs.test.>' });
  await nats.jsm.streams.purge('SCOUT_JOBS', { filter: 'scout.*.jobs.platform.ping' });
  relayAc = new AbortController();
  relayDone = runRelay({ signal: relayAc.signal });
});
afterAll(async () => {
  relayAc.abort();
  await relayDone;
  await nats.nc.drain();
  await closeDbs();
});

const ctxOf = (tenantId: string, tx: ModuleContext['tx'], correlationId = newId('cor')): ModuleContext => ({
  tenantId,
  actor: { kind: 'system', id: 'system' },
  correlationId,
  tx,
});

function start(jobs: JobHandlerDef[]) {
  const ac = new AbortController();
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  const done = startWorker({ jobs, signal: ac.signal, onReady: ready });
  return {
    ready: readyP,
    stop: async () => {
      ac.abort();
      await done;
    },
  };
}

type DeadRow = { id: string; tenant_id: string; consumer_or_job: string; last_error: string; attempts: number; envelope: Envelope };
const deadRowsFor = async (tenantId: string) =>
  (await adminDb.execute(sql`select * from platform.dead_job where tenant_id = ${tenantId}`)) as unknown as DeadRow[];

describe('jobs', () => {
  it('retries with backoff, then stores a dead job and publishes platform.job.dead (PLT-E1-S4-AC1)', async () => {
    const attempts: number[] = [];
    const h = defineJobHandler(alwaysFails, async () => {
      attempts.push(Date.now());
      throw new Error('boom: the outside service said no');
    });
    const w = start([h]);
    try {
      await w.ready;
      const t = newId('t');
      await withTenant(t, (tx) => enqueueJob(ctxOf(t, tx), alwaysFails, { n: 1 }));
      await waitFor(async () => (await deadRowsFor(t)).length === 1, 10000);
      const [row] = await deadRowsFor(t);
      expect(attempts).toHaveLength(3);
      expect((attempts[1] as number) - (attempts[0] as number)).toBeGreaterThanOrEqual(45);
      expect((attempts[2] as number) - (attempts[1] as number)).toBeGreaterThanOrEqual(45);
      expect(row?.attempts).toBe(3);
      expect(row?.consumer_or_job).toBe('test.always_fails');
      expect(row?.last_error).toContain('boom: the outside service said no');
      expect(row?.envelope.type).toBe('jobs.test.always_fails');
      expect(row?.id.startsWith('dead_')).toBe(true);

      const events = (await adminDb.execute(
        sql`select payload from platform.outbox where tenant_id = ${t} and payload->>'type' = 'platform.job.dead'`,
      )) as unknown as { payload: Envelope<{ jobType: string; error: string; attempts: number }> }[];
      expect(events).toHaveLength(1);
      expect(events[0]?.payload.data).toEqual({
        jobType: 'test.always_fails',
        error: expect.stringContaining('boom'),
        attempts: 3,
      });
      expect(events[0]?.payload.correlationId).toBe(row?.envelope.correlationId);

      const listed = await listDeadJobs();
      expect(listed.find((d) => d.id === row?.id)).toMatchObject({
        tenantId: t,
        name: 'test.always_fails',
        attempts: 3,
      });
    } finally {
      await w.stop();
    }
  });

  it('retryDeadJob runs the job again with the same correlation id and removes the dead row (PLT-E1-S4-AC2)', async () => {
    let failing = true;
    const runs: Envelope<{ n: number }>[] = [];
    const h = defineJobHandler(flaky, async (e) => {
      runs.push(e);
      if (failing) throw new Error('not yet');
    });
    const w = start([h]);
    try {
      await w.ready;
      const t = newId('t');
      const correlationId = newId('cor');
      await withTenant(t, (tx) => enqueueJob(ctxOf(t, tx, correlationId), flaky, { n: 7 }));
      await waitFor(async () => (await deadRowsFor(t)).length === 1, 10000);
      const [row] = await deadRowsFor(t);
      expect(runs).toHaveLength(2);

      failing = false;
      const newJobId = await retryDeadJob({ actor: { kind: 'user', id: 'usr_admin' } }, (row as DeadRow).id);
      await waitFor(() => runs.length === 3, 10000);
      const rerun = runs[2] as Envelope<{ n: number }>;
      expect(rerun.id).toBe(newJobId);
      expect(rerun.id).not.toBe(runs[0]?.id);
      expect(rerun.correlationId).toBe(correlationId);
      expect(rerun.data).toEqual({ n: 7 });
      expect(await deadRowsFor(t)).toHaveLength(0);
    } finally {
      await w.stop();
    }
  });

  it('discardDeadJob removes the dead row without running the job', async () => {
    let runs = 0;
    const h = defineJobHandler(discardable, async () => {
      runs++;
      throw new Error('always');
    });
    const w = start([h]);
    try {
      await w.ready;
      const t = newId('t');
      await withTenant(t, (tx) => enqueueJob(ctxOf(t, tx), discardable, { n: 1 }));
      await waitFor(async () => (await deadRowsFor(t)).length === 1, 10000);
      const [row] = await deadRowsFor(t);
      await discardDeadJob({ actor: { kind: 'user', id: 'usr_admin' } }, (row as DeadRow).id);
      expect(await deadRowsFor(t)).toHaveLength(0);
      expect(runs).toBe(1);
      await expect(discardDeadJob({ actor: { kind: 'user', id: 'usr_admin' } }, (row as DeadRow).id)).rejects.toThrow();
    } finally {
      await w.stop();
    }
  });

  it('sendPing round trip produces a ping result within 3 seconds', async () => {
    const w = start([pingHandler]);
    try {
      await w.ready;
      const startedAt = Date.now();
      const id = await withTenant('t_platform', (tx) => sendPing(ctxOf('t_platform', tx)));
      expect(await pingResult(id)).toBeNull();
      await waitFor(async () => (await pingResult(id)) !== null, 3000);
      expect(Date.now() - startedAt).toBeLessThan(3000);
      const r = await pingResult(id);
      expect(r?.handledAt.getTime()).toBeGreaterThanOrEqual(r?.sentAt.getTime() as number);
    } finally {
      await w.stop();
    }
  });
});
