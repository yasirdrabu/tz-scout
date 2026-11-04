// The next step of a plan and its due flags (Ruling 15). Dates are 'YYYY-MM-DD' in the tenant timezone, so they compare as text.

export type OpenableStep = { status: string; dueDate: string; order: number };

/** The earliest step by due date, then order, among `todo` and `in_progress`; null when none is open. */
export function pickNextStep<T extends OpenableStep>(steps: readonly T[]): T | null {
  let best: T | null = null;
  for (const s of steps) {
    if (s.status !== 'todo' && s.status !== 'in_progress') continue;
    if (!best || s.dueDate < best.dueDate || (s.dueDate === best.dueDate && s.order < best.order)) best = s;
  }
  return best;
}

/** Overdue and due-today flags for a due date, judged against `today` in the tenant timezone. */
export function dueFlags(dueDate: string, today: string): { overdue: boolean; dueToday: boolean } {
  return { overdue: dueDate < today, dueToday: dueDate === today };
}
