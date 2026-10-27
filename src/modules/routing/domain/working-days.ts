type Wall = Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;

/** The wall clock in the zone at instant `t`. */
function wallClock(t: number, timezone: string): Wall {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  return Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)])) as Wall;
}

/** Milliseconds the zone is ahead of UTC at instant `t`. */
function offsetAt(t: number, timezone: string): number {
  const p = wallClock(t, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/**
 * `from` plus `days` working days (Monday to Friday, holidays ignored) in the zone, at the same local
 * time of day. Counting starts at the next local day, so from a weekend the first working day is Monday.
 */
export function addWorkingDays(from: Date, days: number, timezone: string): Date {
  if (days <= 0) return from;
  const p = wallClock(from.getTime(), timezone);
  const ms = from.getTime() - Math.floor(from.getTime() / 1000) * 1000;
  let day = p.day;
  let counted = 0;
  while (counted < days) {
    day += 1;
    const weekday = new Date(Date.UTC(p.year, p.month - 1, day)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) counted += 1;
  }
  // Local wall time back to an instant, using the offset in force on the target day.
  const wall = Date.UTC(p.year, p.month - 1, day, p.hour, p.minute, p.second);
  const guess = wall - offsetAt(wall, timezone);
  return new Date(wall - offsetAt(guess, timezone) + ms);
}
