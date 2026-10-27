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
