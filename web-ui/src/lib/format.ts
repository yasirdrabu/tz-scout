// The one place numbers and dates become text (spec index.md, Formatting). Screens never format by hand.

const LOCALE = 'en-US';

type When = string | number | Date;
const toDate = (when: When) => (when instanceof Date ? when : new Date(when));

/** Money from integer minor units (cents) in the tenant's currency: 118300 USD is "$1,183", 118350 is "$1,183.50". */
export function formatMoney(minor: number, currency: string): string {
  const digits = new Intl.NumberFormat(LOCALE, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const amount = minor / 10 ** digits;
  const whole = Number.isInteger(amount);
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency,
    minimumFractionDigits: whole ? 0 : digits,
    maximumFractionDigits: digits,
  }).format(amount);
}

/** A decimal as a percent: 0.15 is "15%", 0.003 is "0.3%". */
export function formatPercent(decimal: number): string {
  return new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 1 }).format(decimal);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(LOCALE).format(n);
}

/** "Oct 26, 2026" in the given IANA timezone. */
export function formatDate(when: When, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(toDate(when));
}

/** "Oct 26, 10:48 AM" in the given IANA timezone. */
export function formatDateTime(when: When, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(
    toDate(when),
  );
}

/** "10:48 AM" in the given IANA timezone. */
export function formatTime(when: When, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: 'numeric', minute: '2-digit' }).format(toDate(when));
}

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "2 days ago", "yesterday", "in 3 days", "just now". */
export function formatRelative(when: When, now: When = new Date()): string {
  const seconds = (toDate(when).getTime() - toDate(now).getTime()) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
  for (const [unit, size] of STEPS) {
    if (abs >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(Math.round(seconds / 60), 'minute');
}

const oneDecimal = (n: number) => new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }).format(n);

/** A length of time from milliseconds: "412 ms", "6.2 s", "6 min", "1.5 h". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${oneDecimal(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${oneDecimal(ms / 3_600_000)} h`;
}

/** A count in short form: 950 is "950", 18400 is "18.4K", 2100000 is "2.1M". */
export function formatCompact(n: number): string {
  return new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
