/** The lists a reason can belong to: review declines, seller declines, both of those, or send backs (Decision 1). */
export const REASON_LISTS = ['review', 'assignment', 'both', 'send_back'] as const;
export type ReasonList = (typeof REASON_LISTS)[number];

export type StatusDefRules = { isDeclined: boolean; returnsToSource: boolean };

export type ReasonDef = { key: string; label: string; appliesTo: ReasonList; noteRequired: boolean; archivedAt: Date | null };

/** The note a reason marked "Note required" asks for, in the words the person sees. */
const noteFor = (reason: { label: string }, sendBack: boolean) => (sendBack ? 'Say what the source should fix.' : `Add a note for ${reason.label}.`);

/** What is missing from an assignment decline: a reason from the assignment list, and a note when the reason needs one. */
export function declineProblems(reason: { label: string; noteRequired: boolean } | undefined, note: string | null | undefined): string[] {
  if (!reason) return ['Pick a reason'];
  return reason.noteRequired && !note?.trim() ? [noteFor(reason, false)] : [];
}

/** Whether a reason belongs to the list a decline (review or seller) or a send back picks from. */
export const inList = (r: Pick<ReasonDef, 'appliesTo'>, list: 'review' | 'assignment' | 'send_back'): boolean =>
  r.appliesTo === list || (list !== 'send_back' && r.appliesTo === 'both');

/**
 * What is missing from a status change, in the words the person sees. Empty means it can go ahead.
 * A declined status needs a review reason, a send back a send-back reason; either needs a note only
 * when its reason is marked "Note required" (Decision 1).
 */
export function statusChangeProblems(
  def: StatusDefRules,
  input: { note?: string | null; reasonKey?: string | null; reasonDefs: ReasonDef[] },
): string[] {
  if (!def.isDeclined && !def.returnsToSource) return [];
  const note = input.note?.trim() ?? '';
  const reasonKey = input.reasonKey?.trim() ?? '';
  const list = def.isDeclined ? 'review' : 'send_back';
  const reason = input.reasonDefs.find((r) => r.key === reasonKey && r.archivedAt === null && inList(r, list));
  if (!reason) return ['Pick a reason'];
  return reason.noteRequired && !note ? [noteFor(reason, list === 'send_back')] : [];
}
