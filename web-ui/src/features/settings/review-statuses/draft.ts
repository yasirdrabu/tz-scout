import type { ReasonEdit, ReasonList, ReviewSettings, ReviewSettingsSave, SettingsReason, SettingsStatus, StatusEdit } from './api';

// The editor's working copy: every status and reason the API sent (archived ones too, so the save
// sends the whole list in order), each with a local id so a new row has a React key.

/** `was` is the name the API sent (null for a new row): the row's controls are named by it, so they keep their names while it is renamed. */
export type StatusRow = Omit<SettingsStatus, 'key' | 'order'> & { id: string; key: string | null; was: string | null };
export type ReasonRow = Omit<SettingsReason, 'key' | 'order'> & { id: string; key: string | null; was: string | null };
export type Draft = { statuses: StatusRow[]; reasons: ReasonRow[]; autoAccept: number | null };

let next = 0;
export const localId = () => `new-${++next}`;

export const toDraft = (s: ReviewSettings): Draft => ({
  statuses: s.statuses.map(({ order: _o, ...r }) => ({ ...r, id: r.key, was: r.label })),
  reasons: s.decline_reasons.map(({ order: _o, ...r }) => ({ ...r, id: r.key, was: r.label })),
  autoAccept: s.auto_accept_working_days,
});

export const statusEdits = (rows: StatusRow[]): StatusEdit[] =>
  rows.map((r) => ({ key: r.key, label: r.label, color: r.color, description: r.description, set_by: r.set_by, flag_after_hours: r.flag_after_hours, archived: r.archived }));

export const reasonEdits = (rows: ReasonRow[]): ReasonEdit[] =>
  rows.map((r) => ({ key: r.key, label: r.label, applies_to: r.applies_to, note_required: r.note_required, archived: r.archived }));

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The parts that changed, for the one PUT; empty when nothing did. */
export function changes(draft: Draft, loaded: Draft): ReviewSettingsSave {
  const out: ReviewSettingsSave = {};
  const statuses = statusEdits(draft.statuses);
  const reasons = reasonEdits(draft.reasons);
  if (!same(statuses, statusEdits(loaded.statuses))) out.statuses = statuses;
  if (!same(reasons, reasonEdits(loaded.reasons))) out.reasons = reasons;
  if (draft.autoAccept !== loaded.autoAccept) out.auto_accept_working_days = draft.autoAccept;
  return out;
}

/** The reasons shown in one list of the editor. */
export const inList = (r: ReasonRow, list: ReasonList) => r.applies_to === list;

/** The API's errors by row: `statuses.{i}.*` and `reasons.{i}.*` at their rows, the rest for the whole form. */
export function errorsByRow(errors: { path: string; message: string }[]) {
  const statuses = new Map<number, string[]>();
  const reasons = new Map<number, string[]>();
  const rest: { path: string; message: string }[] = [];
  for (const e of errors) {
    const m = e.path.match(/^(statuses|reasons)\.(\d+)(?:\.|$)/);
    if (!m) {
      rest.push(e);
      continue;
    }
    const map = m[1] === 'statuses' ? statuses : reasons;
    const i = Number(m[2]);
    map.set(i, [...(map.get(i) ?? []), e.message]);
  }
  return { statuses, reasons, rest };
}
