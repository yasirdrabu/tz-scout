export type StatusDefRules = { isDeclined: boolean; returnsToSource: boolean };
export type ReasonDef = { key: string; appliesTo: 'review' | 'assignment' | 'both'; archivedAt: Date | null };

/** What is missing from a status change, in the words the person sees. Empty means it can go ahead. */
export function statusChangeProblems(
  def: StatusDefRules,
  input: { note?: string | null; reasonKey?: string | null; reasonDefs: ReasonDef[] },
): string[] {
  const problems: string[] = [];
  const note = input.note?.trim() ?? '';
  const reasonKey = input.reasonKey?.trim() ?? '';
  if (def.isDeclined) {
    const reason = input.reasonDefs.find(
      (r) => r.key === reasonKey && r.archivedAt === null && (r.appliesTo === 'review' || r.appliesTo === 'both'),
    );
    if (!reason) problems.push('Pick a reason');
    else if (reason.key === 'other' && !note) problems.push('Add a note for Other.');
  }
  if (def.returnsToSource && !note) problems.push('Say what the source should fix');
  return problems;
}
