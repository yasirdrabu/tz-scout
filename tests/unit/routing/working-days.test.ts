import { describe, expect, it } from 'vitest';
import { addWorkingDays } from '@/modules/routing/domain/working-days';

const NY = 'America/New_York';
const at = (iso: string) => new Date(iso);

describe('addWorkingDays', () => {
  it('adds weekdays within a week', () => {
    expect(addWorkingDays(at('2026-10-26T15:00:00Z'), 2, 'UTC')).toEqual(at('2026-10-28T15:00:00Z')); // Mon to Wed
  });

  it('skips the weekend', () => {
    expect(addWorkingDays(at('2026-10-23T15:00:00Z'), 2, 'UTC')).toEqual(at('2026-10-27T15:00:00Z')); // Fri to Tue
    expect(addWorkingDays(at('2026-10-23T15:00:00Z'), 1, 'UTC')).toEqual(at('2026-10-26T15:00:00Z')); // Fri to Mon
  });

  it('counts from the next Monday at midnight when starting on a weekend', () => {
    expect(addWorkingDays(at('2026-10-24T10:00:00Z'), 1, 'UTC')).toEqual(at('2026-10-27T00:00:00Z')); // Sat 10:00 to Tue 00:00
    expect(addWorkingDays(at('2026-10-25T15:00:00Z'), 2, 'UTC')).toEqual(at('2026-10-28T00:00:00Z')); // Sun 15:00 to Wed 00:00
  });

  it('keeps the time of day from Friday', () => {
    expect(addWorkingDays(at('2026-10-23T15:00:00Z'), 1, 'UTC')).toEqual(at('2026-10-26T15:00:00Z'));
  });

  it('returns the same instant for zero days', () => {
    expect(addWorkingDays(at('2026-10-24T15:00:00Z'), 0, NY)).toEqual(at('2026-10-24T15:00:00Z'));
  });

  it('adds ten working days as two weeks', () => {
    expect(addWorkingDays(at('2026-10-26T15:00:00Z'), 10, 'UTC')).toEqual(at('2026-11-09T15:00:00Z'));
  });

  it('keeps the local time across the 1 November 2026 change in America/New_York', () => {
    // Thu 29 Oct 12:00 EDT (16:00Z) + 2 working days = Mon 2 Nov 12:00 EST (17:00Z).
    expect(addWorkingDays(at('2026-10-29T16:00:00Z'), 2, NY)).toEqual(at('2026-11-02T17:00:00Z'));
  });

  it('uses the tenant day, not the UTC day, to find the weekend', () => {
    // Fri 23 Oct 22:00 EDT is Sat 24 Oct 02:00Z; one working day later is Mon 26 Oct 22:00 EDT.
    expect(addWorkingDays(at('2026-10-24T02:00:00Z'), 1, NY)).toEqual(at('2026-10-27T02:00:00Z'));
  });

  it('crosses the spring change too', () => {
    // Fri 6 Mar 2026 12:00 EST (17:00Z) + 1 = Mon 9 Mar 12:00 EDT (16:00Z).
    expect(addWorkingDays(at('2026-03-06T17:00:00Z'), 1, NY)).toEqual(at('2026-03-09T16:00:00Z'));
  });
});
