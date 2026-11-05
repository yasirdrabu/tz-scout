// Budgets and budget levels (R3a Rulings 6-8). Pure: no database, no clock.

export const LEVELS = ['ok', 'alert', 'over', 'paused'] as const;
export type BudgetLevel = (typeof LEVELS)[number];

export type BudgetRow = { category: string; month: string; amountCents: number };

/** A month's budget: the row for that month, else the latest earlier month's. Null when none. */
export function budgetFor(rows: readonly BudgetRow[], category: string, month: string): number | null {
  let best: BudgetRow | null = null;
  for (const r of rows) {
    if (r.category !== category || r.month > month) continue;
    if (!best || r.month > best.month) best = r;
  }
  return best ? best.amountCents : null;
}

/** `ok` below 90%, `alert` from 90%, `over` from 100%, `paused` from 110% when the category can pause. No budget, or 0, is `ok`. */
export function levelOf(spentCents: number, budgetCents: number | null, pausable: boolean): BudgetLevel {
  if (!budgetCents || budgetCents <= 0) return 'ok';
  // Whole-number comparisons, so 90% is 90% exactly.
  if (spentCents * 10 >= budgetCents * 11) return pausable ? 'paused' : 'over';
  if (spentCents >= budgetCents) return 'over';
  if (spentCents * 10 >= budgetCents * 9) return 'alert';
  return 'ok';
}

/** The tenant-timezone date (YYYY-MM-DD) of an instant. */
export const dayOf = (at: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);

/** The tenant-timezone calendar month (YYYY-MM) of an instant. */
export const monthOf = (at: Date, timeZone: string) => dayOf(at, timeZone).slice(0, 7);

export const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** The month `n` months after `month` (before, when negative). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** The last `n` months up to and including `month`, oldest first. */
export const monthsBack = (month: string, n: number) => Array.from({ length: n }, (_, i) => addMonths(month, i - n + 1));

/** The date `n` days after `day` (before, when negative). */
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
