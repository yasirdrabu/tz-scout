import { describe, expect, it } from 'vitest';
import { CAP_WAIT_JITTER_MS, capWaitMs } from '@/platform/runtime/worker';

const now = Date.parse('2026-11-02T10:00:00Z');
const MIN15 = 15 * 60_000;

describe('capWaitMs (Ruling 10)', () => {
  it('waits until the limit resets when that is within 15 minutes', () => {
    expect(capWaitMs('2026-11-02T10:05:00.000Z', now, 1000, 0)).toBe(5 * 60_000);
  });

  it('waits at most 15 minutes, so a raised limit resumes the work', () => {
    expect(capWaitMs('2026-12-01T05:00:00.000Z', now, 1000, 0)).toBe(MIN15);
  });

  it('waits 15 minutes when resets_at is missing or not a date', () => {
    expect(capWaitMs(undefined, now, 1000, 0)).toBe(MIN15);
    expect(capWaitMs('soon', now, 1000, 0)).toBe(MIN15);
    expect(capWaitMs(42, now, 1000, 0)).toBe(MIN15);
  });

  it('never waits less than the busy minimum, also when resets_at has passed', () => {
    expect(capWaitMs('2026-11-02T10:00:00.200Z', now, 1000, 0)).toBe(1000);
    expect(capWaitMs('2026-11-02T09:00:00.000Z', now, 1000, 0)).toBe(1000);
    expect(capWaitMs('2026-11-02T09:00:00.000Z', now, 1000, CAP_WAIT_JITTER_MS)).toBe(1000);
  });

  it('adds up to a minute of jitter, so waiting jobs do not all come back at the reset', () => {
    expect(capWaitMs('2026-11-02T10:05:00.000Z', now, 1000, 30_000)).toBe(5 * 60_000 + 30_000);
    // Jitter outside 0 to 60 s is held to it: never more than a minute past the reset.
    expect(capWaitMs('2026-11-02T10:05:00.000Z', now, 1000, 10 * 60_000)).toBe(5 * 60_000 + CAP_WAIT_JITTER_MS);
    expect(capWaitMs('2026-11-02T10:05:00.000Z', now, 1000, -5)).toBe(5 * 60_000);
  });

  it('by default the jitter is random within 0 to 60 s', () => {
    for (let i = 0; i < 50; i++) {
      const ms = capWaitMs('2026-11-02T10:05:00.000Z', now, 1000);
      expect(ms).toBeGreaterThanOrEqual(5 * 60_000);
      expect(ms).toBeLessThanOrEqual(5 * 60_000 + CAP_WAIT_JITTER_MS);
    }
  });
});
