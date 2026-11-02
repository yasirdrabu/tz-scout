import { dropAfter, TEST_TEMPLATE } from '../helpers/per-workspace';
import '@/entry/compose';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { workspaceInfra } from '@/modules/tenancy/db/schema';
import { config } from '@/platform/config';
import { controlAdminDb } from '@/platform/db/client';
import { createDatabase } from '@/platform/db/migrate';
import type { Envelope } from '@/platform/events/envelope';
import { defineEvent } from '@/platform/events/registry';
import { newId } from '@/platform/ids';
import { connectNats, type Nats } from '@/platform/nats/connection';
import { ensureStreams } from '@/platform/nats/streams';
import { eventSubject } from '@/platform/nats/subjects';
import { defineConsumer, durableName } from '@/platform/runtime/consumers';
import { startWorker, workspaceInFlightCap } from '@/platform/runtime/worker';
import { waitFor } from '../helpers/wait';

// D35 review: a workspace with a flood of messages must not take a consumer's whole concurrency.
// Each workspace has a database of its own here, so only the worker's own limits are in play.

const flooded = defineEvent('accounts.account.flooded', 1, z.object({ n: z.number() }));
let nats: Nats;

const registered: string[] = [];

/** A workspace in a database of its own, copied from the run's template, registered `active` (no tenant row). */
async function workspace(): Promise<string> {
  const tenantId = newId('t');
  const database = `scout_test_${process.pid}_w${tenantId.slice(-8).toLowerCase()}`;
  await createDatabase(database, TEST_TEMPLATE);
  dropAfter(database);
  await controlAdminDb.insert(workspaceInfra).values({ tenantId, region: 'us-1', database, status: 'active' });
  registered.push(tenantId);
  return tenantId;
}

const envelope = (tenantId: string, n: number): Envelope<{ n: number }> => ({
  id: newId('evt'),
  type: flooded.type,
  schemaVersion: 1,
  tenantId,
  occurredAt: new Date().toISOString(),
  actor: { kind: 'system', id: 'system' },
  correlationId: newId('cor'),
  data: { n },
});
const deliver = (e: Envelope<unknown>) => nats.js.publish(eventSubject(e.tenantId, e.type), JSON.stringify(e), { msgID: e.id });

beforeAll(async () => {
  nats = await connectNats();
  await ensureStreams(nats.jsm);
});
afterAll(async () => {
  await nats.nc.drain();
  // Registry rows with no tenant would be orphans to the later files' checks.
  if (registered.length > 0) await controlAdminDb.delete(workspaceInfra).where(inArray(workspaceInfra.tenantId, registered));
});

it("a workspace flooding one consumer leaves room for another workspace's message", async () => {
  expect(config.workspaceDatabases).toBe('per_workspace');
  const a = await workspace();
  const b = await workspace();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let handledA = 0;
  let handledB: number | undefined;
  const c = defineConsumer({
    name: `test.flood_${newId('run').slice(4)}`,
    event: flooded,
    handle: async (e, ctx) => {
      if (ctx.tenantId === b) handledB = Date.now();
      else {
        await gate;
        handledA++;
      }
    },
  });
  // More concurrency than one workspace may run at once, so a fair consumer always has room left.
  const concurrency = workspaceInFlightCap()! + 3;
  const ac = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>((r) => (ready = r));
  const done = startWorker({ consumers: [c], concurrency, signal: ac.signal, onReady: ready });
  try {
    await started;
    const flood = 4 * concurrency;
    for (let n = 0; n < flood; n++) await deliver(envelope(a, n));
    // Let the flood fill what it can: its workspace's slots, and its waiters.
    await new Promise((r) => setTimeout(r, 300));
    const sentB = Date.now();
    await deliver(envelope(b, 0));
    await waitFor(() => handledB !== undefined, 5000);
    expect(handledB! - sentB).toBeLessThan(600);
    release();
    await waitFor(() => handledA >= flood, 30000);
  } finally {
    release();
    ac.abort();
    await done;
    await nats.jsm.consumers.delete('SCOUT_EVENTS', durableName(c)).catch(() => {});
  }
}, 60000);
