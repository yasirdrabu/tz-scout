import { offsetAt, wallClock } from '@/platform/time';

export type CapUnit = 'calls' | 'credits' | 'cost_cents';
export type CapPeriod = 'day' | 'month';
export type CapLevel = 'ok' | 'warn' | 'blocked';

/** Ruling 2: lazily ensured for each tenant. Providers without a default have no limit. */
export const DEFAULT_CAPS: Readonly<Record<string, { limit: number; unit: CapUnit; period: CapPeriod }>> = {
  apollo: { limit: 2000, unit: 'credits', period: 'month' },
  vibe: { limit: 1000, unit: 'credits', period: 'month' },
  anthropic: { limit: 20000, unit: 'cost_cents', period: 'month' },
  hubspot: { limit: 50000, unit: 'calls', period: 'day' },
};

/**
 * The first instant of calendar day y-m-d in the zone (month and day may overflow): the earliest of
 * midnight at either nearby offset that falls on that day. Where clocks skip midnight
 * (America/Santiago, 2026-09-06) that is the transition, midnight at the offset before it.
 */
function midnight(year: number, month: number, day: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day);
  const target = new Date(wall);
  const first = wall - offsetAt(wall, timeZone);
  const onDay = [wall - offsetAt(first, timeZone), first].filter((t) => {
    const p = wallClock(t, timeZone);
    return p.year === target.getUTCFullYear() && p.month === target.getUTCMonth() + 1 && p.day === target.getUTCDate();
  });
  return new Date(onDay.length ? Math.min(...onDay) : first);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The local period that contains `now` (Ruling 4): its first day, and the instant the next period starts. */
export function periodBounds(period: CapPeriod, now: Date, timeZone: string): { start: string; resetsAt: Date } {
  const p = wallClock(now.getTime(), timeZone);
  if (period === 'day') {
    return { start: `${p.year}-${pad(p.month)}-${pad(p.day)}`, resetsAt: midnight(p.year, p.month, p.day + 1, timeZone) };
  }
  return { start: `${p.year}-${pad(p.month)}-01`, resetsAt: midnight(p.year, p.month + 1, 1, timeZone) };
}

/**
 * Ruling 7. `reserved` includes any reservation being asked for. Blocked when settled usage reaches the
 * limit or the reservations would pass it, unless overage is allowed; warn at 80% of the limit.
 */
export function levelOf(used: number, reserved: number, limit: number, overage: boolean): CapLevel {
  if (!overage && (used >= limit || used + reserved > limit)) return 'blocked';
  return (used + reserved) * 5 >= limit * 4 ? 'warn' : 'ok';
}
