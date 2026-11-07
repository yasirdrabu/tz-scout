/** An outcome credits the steps done in the 14 days before it. */
export const CREDIT_WINDOW_MS = 14 * 86_400_000;

/** The done steps with `at − 14d ≤ doneAt ≤ at`, ordered by doneAt then id. None means "no recent step". */
export function creditedSteps(steps: { id: string; channel: string; status: string; doneAt: Date | null }[], at: Date): { stepId: string; channel: string }[] {
  const to = at.getTime();
  const from = to - CREDIT_WINDOW_MS;
  return steps
    .filter((s) => s.status === 'done' && s.doneAt && s.doneAt.getTime() >= from && s.doneAt.getTime() <= to)
    .sort((a, b) => a.doneAt!.getTime() - b.doneAt!.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((s) => ({ stepId: s.id, channel: s.channel }));
}
