import { offsetAt, wallClock, type Wall } from '@/platform/time';

/**
 * `from` plus `days` working days (Monday to Friday, holidays ignored) in the zone, at the same local
 * time of day. From a weekend, counting starts at the following Monday's local midnight, so a full
 * Monday passes and the result is at 00:00 local.
 */
export function addWorkingDays(from: Date, days: number, timezone: string): Date {
  if (days <= 0) return from;
  let p = wallClock(from.getTime(), timezone);
  let ms = from.getTime() - Math.floor(from.getTime() / 1000) * 1000;
  const startWeekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  if (startWeekday === 0 || startWeekday === 6) {
    const toMonday = startWeekday === 6 ? 2 : 1;
    p = { ...p, day: p.day + toMonday, hour: 0, minute: 0, second: 0 };
    ms = 0;
  }
  let day = p.day;
  let counted = 0;
  while (counted < days) {
    day += 1;
    const weekday = new Date(Date.UTC(p.year, p.month - 1, day)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) counted += 1;
  }
  return localInstant(p, day, ms, timezone);
}

/** Local wall time on calendar day `day` of p's month back to an instant, using the offset in force that day. */
function localInstant(p: Wall, day: number, ms: number, timezone: string): Date {
  const wall = Date.UTC(p.year, p.month - 1, day, p.hour, p.minute, p.second);
  const guess = wall - offsetAt(wall, timezone);
  return new Date(wall - offsetAt(guess, timezone) + ms);
}
