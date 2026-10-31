// Rules for the review status and reason editor (REV-E1-S4, Decision 2). Pure: the service loads and saves.

import { inList, REASON_LISTS, type ReasonList } from './status-rules';

export const STATUS_COLORS = ['plum', 'amber', 'green', 'red', 'gray'] as const;
export type StatusColor = (typeof STATUS_COLORS)[number];
/** Who moves an account into the status: Scout on its own, or a reviewer. */
export const STATUS_SET_BY = ['scout', 'reviewer'] as const;
export type StatusSetBy = (typeof STATUS_SET_BY)[number];

export const MAX_FLAG_AFTER_HOURS = 720;
const MAX_STATUSES = 30;
const MAX_REASONS = 60;
const MAX_LABEL = 60;
const MAX_DESCRIPTION = 300;

export type Problem = { path: string; message: string };

export type StatusRow = {
  key: string;
  label: string;
  countsAsReviewed: boolean;
  isDeclined: boolean;
  isInitial: boolean;
  returnsToSource: boolean;
  archivedAt: Date | null;
};

export type StatusEdit = {
  key?: string | null;
  label: string;
  color: string;
  description?: string | null;
  setBy: string;
  flagAfterHours: number | null;
  archived?: boolean;
};

export type ReasonRow = { key: string; label: string; appliesTo: ReasonList; archivedAt: Date | null };
export type ReasonEdit = { key?: string | null; label: string; appliesTo: string; noteRequired: boolean; archived?: boolean };

/** The statuses Scout relies on (the first status, the reviewed and declined ones, send back): renamed and recolored, never archived. */
export const isRequired = (s: Pick<StatusRow, 'isInitial' | 'countsAsReviewed' | 'isDeclined' | 'returnsToSource'>): boolean =>
  s.isInitial || s.countsAsReviewed || s.isDeclined || s.returnsToSource;

/** A status that counts as reviewed is final: it never gets late, so it has no "Flag after". */
export const isFinal = (s: Pick<StatusRow, 'countsAsReviewed'>): boolean => s.countsAsReviewed;

/** A stable key from a label, not one of `taken`. */
export function keyFor(label: string, taken: Set<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'item';
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

/** Edits must keep every live row: they are archived, never removed. Shared by both lists. */
function missingRows<T extends { key: string; label: string; archivedAt: Date | null }>(existing: T[], edits: { key?: string | null }[], path: string): Problem[] {
  const sent = new Set(edits.map((e) => e.key).filter(Boolean));
  return existing.filter((r) => !r.archivedAt && !sent.has(r.key)).map((r) => ({ path, message: `Archive ${r.label} instead of removing it.` }));
}

function keyProblems(existing: { key: string }[], edits: { key?: string | null }[], path: string): Problem[] {
  const known = new Set(existing.map((r) => r.key));
  const seen = new Set<string>();
  const problems: Problem[] = [];
  edits.forEach((e, i) => {
    if (!e.key) return;
    if (!known.has(e.key)) problems.push({ path: `${path}.${i}.key`, message: 'That one is not in your list. Leave the key out to add a new one.' });
    else if (seen.has(e.key)) problems.push({ path: `${path}.${i}.key`, message: 'Each one can appear once.' });
    seen.add(e.key);
  });
  return problems;
}

const labelProblem = (label: string, path: string): Problem | null =>
  !label.trim() ? { path, message: 'Give it a name.' } : label.trim().length > MAX_LABEL ? { path, message: `Keep the name to ${MAX_LABEL} characters.` } : null;

/** What is wrong with a full list of statuses, in order, for the editor. Empty means it can be saved. */
export function statusEditProblems(existing: StatusRow[], edits: StatusEdit[]): Problem[] {
  if (edits.length === 0 || edits.length > MAX_STATUSES) return [{ path: 'statuses', message: `Keep 1 to ${MAX_STATUSES} statuses.` }];
  const problems = [...keyProblems(existing, edits, 'statuses'), ...missingRows(existing, edits, 'statuses')];
  const byKey = new Map(existing.map((s) => [s.key, s]));
  const live = new Map<string, number>();
  edits.forEach((e, i) => {
    const at = (field: string) => `statuses.${i}.${field}`;
    const row = e.key ? byKey.get(e.key) : undefined;
    const label = labelProblem(e.label, at('label'));
    if (label) problems.push(label);
    if (!(STATUS_COLORS as readonly string[]).includes(e.color)) problems.push({ path: at('color'), message: 'Pick plum, amber, green, red or gray.' });
    if (!(STATUS_SET_BY as readonly string[]).includes(e.setBy)) problems.push({ path: at('set_by'), message: 'Pick Scout or a reviewer.' });
    if ((e.description ?? '').length > MAX_DESCRIPTION) problems.push({ path: at('description'), message: `Keep what it means to ${MAX_DESCRIPTION} characters.` });
    if (e.flagAfterHours !== null) {
      if (row && isFinal(row)) problems.push({ path: at('flag_after_hours'), message: `${e.label.trim() || row.label} is final, so it is never flagged.` });
      else if (!Number.isInteger(e.flagAfterHours) || e.flagAfterHours < 1 || e.flagAfterHours > MAX_FLAG_AFTER_HOURS) {
        problems.push({ path: at('flag_after_hours'), message: `Flag after 1 to ${MAX_FLAG_AFTER_HOURS} hours, or never.` });
      }
    }
    if (e.archived && !row) problems.push({ path: at('archived'), message: 'A new status cannot start archived.' });
    if (e.archived && row && isRequired(row)) problems.push({ path: at('archived'), message: `${row.label} can't be archived. Scout needs it.` });
    if (!e.archived && e.label.trim()) {
      const name = e.label.trim().toLowerCase();
      if (live.has(name)) problems.push({ path: at('label'), message: `Two statuses are called ${e.label.trim()}.` });
      live.set(name, i);
    }
  });
  return problems;
}

const LIST_NEEDED: { list: 'review' | 'assignment' | 'send_back'; message: string }[] = [
  { list: 'send_back', message: 'Keep at least one send-back reason.' },
  { list: 'review', message: 'Keep at least one reason for not pursuing an account.' },
  { list: 'assignment', message: 'Keep at least one decline reason for AEs.' },
];

/** What is wrong with a full list of reasons, for the editor. Empty means it can be saved. */
export function reasonEditProblems(existing: ReasonRow[], edits: ReasonEdit[]): Problem[] {
  if (edits.length === 0 || edits.length > MAX_REASONS) return [{ path: 'reasons', message: `Keep 1 to ${MAX_REASONS} reasons.` }];
  const problems = [...keyProblems(existing, edits, 'reasons'), ...missingRows(existing, edits, 'reasons')];
  const known = new Set(existing.map((r) => r.key));
  const live = new Set<string>();
  edits.forEach((e, i) => {
    const at = (field: string) => `reasons.${i}.${field}`;
    const label = labelProblem(e.label, at('label'));
    if (label) problems.push(label);
    if (!(REASON_LISTS as readonly string[]).includes(e.appliesTo)) problems.push({ path: at('applies_to'), message: 'Pick review, assignment, both or send_back.' });
    if (e.archived && !(e.key && known.has(e.key))) problems.push({ path: at('archived'), message: 'A new reason cannot start archived.' });
    if (!e.archived && e.label.trim()) {
      const name = `${e.appliesTo}:${e.label.trim().toLowerCase()}`;
      if (live.has(name)) problems.push({ path: at('label'), message: `${e.label.trim()} is in this list twice.` });
      live.add(name);
    }
  });
  const kept = edits.filter((e) => !e.archived && (REASON_LISTS as readonly string[]).includes(e.appliesTo)) as { appliesTo: ReasonList }[];
  for (const need of LIST_NEEDED) if (!kept.some((e) => inList(e, need.list))) problems.push({ path: 'reasons', message: need.message });
  return problems;
}
