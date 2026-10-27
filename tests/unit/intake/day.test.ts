import { describe, expect, it } from 'vitest';
import { nextTenantDay, tenantDayStart } from '@/modules/intake/domain/day';

const iso = (d: Date) => d.toISOString();

describe('tenantDayStart', () => {
  it('is the local midnight before the instant, across the November change', () => {
    expect(iso(tenantDayStart(new Date('2026-11-01T03:30:00Z'), 'America/New_York'))).toBe('2026-10-31T04:00:00.000Z');
    expect(iso(tenantDayStart(new Date('2026-11-01T12:00:00Z'), 'America/New_York'))).toBe('2026-11-01T04:00:00.000Z');
  });
  it('is UTC midnight for UTC', () => {
    expect(iso(tenantDayStart(new Date('2026-11-01T23:59:59Z'), 'UTC'))).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('nextTenantDay', () => {
  it('is the next local midnight, after the clocks go back', () => {
    expect(iso(nextTenantDay(new Date('2026-11-01T12:00:00Z'), 'America/New_York'))).toBe('2026-11-02T05:00:00.000Z');
    expect(iso(nextTenantDay(new Date('2026-10-31T12:00:00Z'), 'America/New_York'))).toBe('2026-11-01T04:00:00.000Z');
  });
  it('crosses a month end', () => {
    expect(iso(nextTenantDay(new Date('2026-10-31T23:00:00Z'), 'UTC'))).toBe('2026-11-01T00:00:00.000Z');
  });
});
