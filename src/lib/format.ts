/** Date and time as "25 Oct 2026, 14:05 UTC". Screens never format dates by hand. */
export function formatDateTime(d: Date | string | null | undefined, timeZone = 'UTC'): string {
  if (!d) return 'Never';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return 'Never';
  const text = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(date);
  return `${text}${timeZone === 'UTC' ? ' UTC' : ''}`;
}

/** 1,250 ms as "1,250 ms"; 90,000 ms as "1.5 min". */
export function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${ms.toLocaleString('en-US')} ms`;
}

/** Whole cents as dollars with two decimals, for small run costs. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
