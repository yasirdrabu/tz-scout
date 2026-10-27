// Wall-clock helpers shared by modules that work in a tenant timezone.
export type Wall = Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;

/** The wall clock in the zone at instant `t`. */
export function wallClock(t: number, timezone: string): Wall {
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
export function offsetAt(t: number, timezone: string): number {
  const p = wallClock(t, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
