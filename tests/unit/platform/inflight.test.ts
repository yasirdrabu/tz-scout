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

it('keyed slots limit each key on its own', async () => {
  const slots = new KeyedSlots(1);
  await slots.acquire('t_a');
  await slots.acquire('t_b'); // another workspace is not held up
  let second = false;
  const waiting = slots.acquire('t_a').then(() => (second = true));
  await Promise.resolve();
  expect(second).toBe(false);
  slots.release('t_a');
  await waiting;
  expect(second).toBe(true);
});
