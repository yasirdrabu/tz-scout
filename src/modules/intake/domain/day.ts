import { offsetAt, wallClock } from '@/platform/time';

/** The instant of local midnight at the start of calendar day y-m-d in the zone. */
function midnight(year: number, month: number, day: number, timezone: string): Date {
  const wall = Date.UTC(year, month - 1, day);
  const first = wall - offsetAt(wall, timezone);
  return new Date(wall - offsetAt(first, timezone));
}

/** The start of the tenant's local day that contains `now`. */
export function tenantDayStart(now: Date, timezone: string): Date {
  const p = wallClock(now.getTime(), timezone);
  return midnight(p.year, p.month, p.day, timezone);
}

/** The start of the tenant's next local day. */
export function nextTenantDay(now: Date, timezone: string): Date {
  const p = wallClock(now.getTime(), timezone);
  return midnight(p.year, p.month, p.day + 1, timezone);
}
