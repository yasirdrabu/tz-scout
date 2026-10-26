import { expect, it } from 'vitest';
import { inFlightCap } from '@/platform/runtime/worker';

it('keeps messages in flight to at most half of the connection pool', () => {
  // DATABASE_POOL_MAX defaults to 20 in tests
  expect(inFlightCap()).toBe(10);
  expect(inFlightCap(50)).toBe(10);
  expect(inFlightCap(3)).toBe(3);
  expect(inFlightCap(0)).toBe(1);
});
