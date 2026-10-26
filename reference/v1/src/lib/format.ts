// Display formatting. Money is integer cents in storage; these only shape it for people.

export function money(cents: number | null | undefined, currency = "USD", opts: { precise?: boolean; compact?: boolean } = {}): string {
  if (cents == null || !Number.isFinite(cents)) return "n/a";
  const dollars = cents / 100;
  if (opts.compact && Math.abs(dollars) >= 10000) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(dollars);
  }
  const digits = opts.precise || (Math.abs(dollars) < 100 && !Number.isInteger(dollars)) ? 2 : 0;
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(dollars);
}

export function pct(rate: number | null | undefined, digits = 1): string {
  if (rate == null || !Number.isFinite(rate)) return "n/a";
  return `${(rate * 100).toFixed(digits)}%`;
}

export function num(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
}

export function compact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function multiple(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${n.toFixed(1)}x`;
}

export function date(d: Date | string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(new Date(d));
}

export function dateTime(d: Date | string | null | undefined): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(d));
}

export function relative(d: Date | string | null | undefined, now = new Date()): string {
  if (!d) return "";
  const ms = new Date(d).getTime() - now.getTime();
  const abs = Math.abs(ms);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [[86400000, "day"], [3600000, "hour"], [60000, "minute"]];
  const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  for (const [size, unit] of units) if (abs >= size) return rtf.format(Math.round(ms / size), unit);
  return "just now";
}

export function rangeMoney(min: number | null | undefined, max: number | null | undefined, currency = "USD"): string {
  if (min == null && max == null) return "n/a";
  if (min != null && max != null && min !== max) return `${money(min, currency, { compact: true })} to ${money(max, currency, { compact: true })}`;
  return money(min ?? max, currency, { compact: true });
}
