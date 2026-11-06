import { describe, expect, it } from 'vitest';
import { periodRange } from '@/modules/analytics/domain/period';

const NY = 'America/New_York';
const now = new Date('2026-11-05T15:00:00Z');
const localHm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: NY, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

describe('periodRange', () => {
  it('90d on 2026-11-05 starts 2026-08-08, and 30d includes today', () => {
    const r = periodRange('90d', now, NY);
    expect(r.fromDay).toBe('2026-08-08');
    expect(r.toDay).toBe('2026-11-05');
    expect(r.to).toEqual(now);
    expect(periodRange('30d', now, NY).fromDay).toBe('2026-10-07');
  });
  it('quarter starts 2026-10-01 and year 2026-01-01', () => {
    expect(periodRange('quarter', now, NY).fromDay).toBe('2026-10-01');
    expect(periodRange('year', now, NY).fromDay).toBe('2026-01-01');
  });
  it('every start is a tenant-local midnight, across a DST change', () => {
    for (const k of ['30d', '90d', 'quarter', 'year'] as const) expect(localHm(periodRange(k, now, NY).from)).toBe('00:00');
    expect(periodRange('year', now, NY).from.toISOString()).toBe('2026-01-01T05:00:00.000Z');
    expect(periodRange('90d', now, NY).from.toISOString()).toBe('2026-08-08T04:00:00.000Z');
  });
  it('uses the tenant day, not the UTC day', () => {
    expect(periodRange('30d', new Date('2026-11-06T02:00:00Z'), NY).toDay).toBe('2026-11-05');
  });
});
