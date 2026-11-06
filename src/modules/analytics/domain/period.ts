// Funnel periods in the tenant timezone. Pure: the clock comes in as `now`.
import { addDays, dayOf } from './budgets';

export type PeriodKey = '30d' | '90d' | 'quarter' | 'year';

/** The UTC instant of midnight at the start of `day` (YYYY-MM-DD) in `timeZone`. */
function localMidnight(day: string, timeZone: string): Date {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(t / 1000) * 1000;
  };
  const naive = Date.parse(`${day}T00:00:00Z`);
  // Two passes settle the offset even when it differs between the guess and the answer (DST).
  let t = naive - offsetAt(naive);
  t = naive - offsetAt(t);
  return new Date(t);
}

export function periodRange(key: PeriodKey, now: Date, timezone: string): { from: Date; to: Date; fromDay: string; toDay: string } {
  const toDay = dayOf(now, timezone);
  let fromDay: string;
  if (key === '30d') fromDay = addDays(toDay, -29);
  else if (key === '90d') fromDay = addDays(toDay, -89);
  else if (key === 'year') fromDay = `${toDay.slice(0, 4)}-01-01`;
  else {
    const m = Number(toDay.slice(5, 7));
    fromDay = `${toDay.slice(0, 4)}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  }
  return { from: localMidnight(fromDay, timezone), to: now, fromDay, toDay };
}
