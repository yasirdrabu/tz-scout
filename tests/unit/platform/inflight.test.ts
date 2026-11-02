import { expect, it } from 'vitest';
import { inFlightCap, KeyedSlots, workspaceInFlightCap } from '@/platform/runtime/worker';

it('shared mode: keeps messages in flight to at most half of the connection pool', () => {
  const shared = { workspaceDatabases: 'shared', databasePoolMax: 20, workspacePoolMax: 3, workspacePoolCap: 60 } as const;
  expect(inFlightCap(undefined, shared)).toBe(10);
  expect(inFlightCap(50, shared)).toBe(10);
  expect(inFlightCap(3, shared)).toBe(3);
  expect(inFlightCap(0, shared)).toBe(1);
  // One pool for every workspace, no limit per workspace.
  expect(workspaceInFlightCap(shared)).toBeNull();
});

it('per_workspace: half the workspace connection cap across the worker, one less than a workspace pool each (D35)', () => {
  const per = (workspacePoolMax: number) =>
    ({ workspaceDatabases: 'per_workspace', databasePoolMax: 20, workspacePoolMax, workspacePoolCap: 60 }) as const;
  expect(inFlightCap(undefined, per(3))).toBe(30);
  expect(workspaceInFlightCap(per(3))).toBe(2);
  expect(workspaceInFlightCap(per(8))).toBe(7);
  expect(workspaceInFlightCap(per(1))).toBe(1);
});

it("a full workspace is told so at once (tryAcquire), holding nothing, while another workspace's messages still get in", () => {
  const slots = new KeyedSlots(1);
  expect(slots.tryAcquire('t_a')).toBe(true);
  // The rest of t_a's burst: refused at once; runSub sets them aside to wait (acquire, below) outside
  // the consumer's concurrency (worker-fairness.test.ts).
  for (let i = 0; i < 20; i++) expect(slots.tryAcquire('t_a')).toBe(false);
  expect(slots.tryAcquire('t_b')).toBe(true);
  slots.release('t_a');
  expect(slots.tryAcquire('t_a')).toBe(true);
});

it('a few of a busy workspace wait a moment for a slot, in order; the rest are refused at once (D35)', async () => {
  const slots = new KeyedSlots(1, 1);
  expect(await slots.acquire('t_a', 1000)).toBe(true);
  // One waits (the queue holds one here); the next is put back without waiting.
  const order: string[] = [];
  const waiting = slots.acquire('t_a', 1000).then((ok) => void order.push(`first ${ok}`));
  expect(await slots.acquire('t_a', 1000)).toBe(false);
  expect(await slots.acquire('t_b', 1000)).toBe(true);
  // A release hands the slot straight to the one waiting.
  slots.release('t_a');
  await waiting;
  expect(order).toEqual(['first true']);
  expect(slots.tryAcquire('t_a')).toBe(false);
  // A wait that runs out gives up, holding nothing.
  expect(await slots.acquire('t_a', 20)).toBe(false);
  slots.release('t_a');
  expect(slots.tryAcquire('t_a')).toBe(true);
});
