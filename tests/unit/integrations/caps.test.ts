import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPS, levelOf, periodBounds } from '@/modules/integrations/domain/caps';

describe('periodBounds', () => {
  it('UTC day and month', () => {
    const now = new Date('2026-11-02T15:30:00Z');
    expect(periodBounds('day', now, 'UTC')).toEqual({ start: '2026-11-02', resetsAt: new Date('2026-11-03T00:00:00Z') });
    expect(periodBounds('month', now, 'UTC')).toEqual({ start: '2026-11-01', resetsAt: new Date('2026-12-01T00:00:00Z') });
  });

  it('December rolls the month reset into next year', () => {
    expect(periodBounds('month', new Date('2026-12-15T00:00:00Z'), 'UTC').resetsAt).toEqual(new Date('2027-01-01T00:00:00Z'));
    expect(periodBounds('day', new Date('2026-12-31T12:00:00Z'), 'UTC').resetsAt).toEqual(new Date('2027-01-01T00:00:00Z'));
  });

  it('America/New_York: 2026-12-01 03:00 UTC is still November, 05:01 UTC is December (Review Focus 2)', () => {
    const tz = 'America/New_York';
    expect(periodBounds('month', new Date('2026-12-01T03:00:00Z'), tz)).toEqual({
      start: '2026-11-01',
      resetsAt: new Date('2026-12-01T05:00:00Z'),
    });
    expect(periodBounds('month', new Date('2026-12-01T05:01:00Z'), tz)).toEqual({
      start: '2026-12-01',
      resetsAt: new Date('2027-01-01T05:00:00Z'),
    });
    expect(periodBounds('day', new Date('2026-12-01T03:00:00Z'), tz)).toEqual({
      start: '2026-11-30',
      resetsAt: new Date('2026-12-01T05:00:00Z'),
    });
  });

  it('America/New_York: the month that crosses the DST change resets at the new offset', () => {
    // Clocks fall back at 02:00 on 2026-11-01, so its midnight is still EDT (-4): 04:00 UTC.
    expect(periodBounds('month', new Date('2026-10-15T12:00:00Z'), 'America/New_York').resetsAt).toEqual(
      new Date('2026-11-01T04:00:00Z'),
    );
  });

  it('Asia/Kolkata (+05:30)', () => {
    const tz = 'Asia/Kolkata';
    // 2026-11-30 19:00 UTC is 2026-12-01 00:30 in Kolkata.
    expect(periodBounds('month', new Date('2026-11-30T19:00:00Z'), tz)).toEqual({
      start: '2026-12-01',
      resetsAt: new Date('2026-12-31T18:30:00Z'),
    });
    expect(periodBounds('day', new Date('2026-11-30T18:00:00Z'), tz)).toEqual({
      start: '2026-11-30',
      resetsAt: new Date('2026-11-30T18:30:00Z'),
    });
  });
});

describe('levelOf', () => {
  it('79% is ok, 80% is warn', () => {
    expect(levelOf(79, 0, 100, false)).toBe('ok');
    expect(levelOf(80, 0, 100, false)).toBe('warn');
    expect(levelOf(70, 10, 100, false)).toBe('warn');
  });

  it('a reservation over the limit is blocked; exactly the limit is not', () => {
    expect(levelOf(90, 11, 100, false)).toBe('blocked');
    expect(levelOf(90, 10, 100, false)).toBe('warn');
  });

  it('settled usage at the limit is blocked', () => {
    expect(levelOf(100, 0, 100, false)).toBe('blocked');
  });

  it('overage stops blocking, warn still shows', () => {
    expect(levelOf(100, 50, 100, true)).toBe('warn');
    expect(levelOf(10, 0, 100, true)).toBe('ok');
  });
});

describe('DEFAULT_CAPS', () => {
  it('matches Ruling 2', () => {
    expect(DEFAULT_CAPS).toEqual({
      apollo: { limit: 2000, unit: 'credits', period: 'month' },
      vibe: { limit: 1000, unit: 'credits', period: 'month' },
      anthropic: { limit: 20000, unit: 'cost_cents', period: 'month' },
      hubspot: { limit: 50000, unit: 'calls', period: 'day' },
    });
  });
});
