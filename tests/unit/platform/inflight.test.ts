import { expect, it } from 'vitest';
import { inFlightCap, KeyedSlots, workspaceInFlightCap } from '@/platform/runtime/worker';

it('keeps messages in flight to at most half of the connection pool', () => {
  // DATABASE_POOL_MAX defaults to 20 in tests
  expect(inFlightCap()).toBe(10);
  expect(inFlightCap(50)).toBe(10);
  expect(inFlightCap(3)).toBe(3);
  expect(inFlightCap(0)).toBe(1);
  // Shared mode: one pool for every workspace, no limit per workspace.
  expect(workspaceInFlightCap()).toBeNull();
});

it('per_workspace: half the workspace connection cap across the worker, half a workspace pool each (D35)', () => {
  const per = (workspacePoolMax: number) =>
    ({ workspaceDatabases: 'per_workspace', databasePoolMax: 20, workspacePoolMax, workspacePoolCap: 60 }) as const;
  expect(inFlightCap(undefined, per(3))).toBe(30);
  expect(workspaceInFlightCap(per(3))).toBe(1);
  expect(workspaceInFlightCap(per(8))).toBe(4);
  expect(workspaceInFlightCap(per(1))).toBe(1);
});

it("a burst from one workspace is put back, never waited on, so another workspace's messages still get in", () => {
  const slots = new KeyedSlots(1);
  expect(slots.tryAcquire('t_a')).toBe(true);
  // The rest of t_a's burst: refused at once (the worker naks them for 500 ms), holding nothing.
  for (let i = 0; i < 20; i++) expect(slots.tryAcquire('t_a')).toBe(false);
  expect(slots.tryAcquire('t_b')).toBe(true);
  slots.release('t_a');
  expect(slots.tryAcquire('t_a')).toBe(true);
});
