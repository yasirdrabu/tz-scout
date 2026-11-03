import { describe, expect, it } from 'vitest';
import { capWaitMs } from '@/platform/runtime/worker';

const now = Date.parse('2026-11-02T10:00:00Z');
const MIN15 = 15 * 60_000;

describe('capWaitMs (Ruling 10)', () => {
  it('waits until the limit resets when that is within 15 minutes', () => {
    expect(capWaitMs('2026-11-02T10:05:00.000Z', now, 1000)).toBe(5 * 60_000);
  });

  it('waits at most 15 minutes, so a raised limit resumes the work', () => {
    expect(capWaitMs('2026-12-01T05:00:00.000Z', now, 1000)).toBe(MIN15);
  });

  it('waits 15 minutes when resets_at is missing or not a date', () => {
    expect(capWaitMs(undefined, now, 1000)).toBe(MIN15);
    expect(capWaitMs('soon', now, 1000)).toBe(MIN15);
    expect(capWaitMs(42, now, 1000)).toBe(MIN15);
  });

  it('never waits less than the busy minimum, also when resets_at has passed', () => {
    expect(capWaitMs('2026-11-02T10:00:00.200Z', now, 1000)).toBe(1000);
    expect(capWaitMs('2026-11-02T09:00:00.000Z', now, 1000)).toBe(1000);
  });
});
