import type { Stage, StageEdit, StagesView, Trigger } from './api';

// The editor's working copy: flow stages in order, then exits, as the save sends them (so an error's
// `stages.{i}` path is the row's place in this list). Each row has a local id for React keys.

export type Row = {
  id: string;
  key: string | null;
  /** The name the API sent (null for a new row): the row's controls are named by it, so they keep their names while it is renamed. */
  was: string | null;
  name: string;
  description: string;
  kind: 'flow' | 'exit';
  trigger: string;
  hubspot_stage: string;
  quarter_target: string;
  locked: Stage['locked'];
};

let next = 0;
export const localId = () => `new-${++next}`;

const toRow = (s: Stage): Row => ({
  id: s.key,
  key: s.key,
  was: s.name,
  name: s.name,
  description: s.description ?? '',
  kind: s.kind,
  trigger: s.trigger,
  hubspot_stage: s.hubspot_stage ?? '',
  quarter_target: s.quarter_target === null ? '' : String(s.quarter_target),
  locked: s.locked,
});

const ordered = (rows: Row[]) => [...rows.filter((r) => r.kind === 'flow'), ...rows.filter((r) => r.kind === 'exit')];

export const toDraft = (stages: Stage[]): Row[] => ordered(stages.map(toRow));

/** Restore defaults: the defaults list as the draft, nothing saved. Default stages keep their keys. */
export const defaultsDraft = (view: StagesView): Row[] => toDraft(view.defaults);

export const toEdits = (rows: Row[]): StageEdit[] =>
  rows.map((r) => {
    const target = r.quarter_target.trim();
    return {
      ...(r.key ? { key: r.key } : {}),
      name: r.name.trim(),
      description: r.description.trim() || null,
      kind: r.kind,
      trigger: r.trigger,
      hubspot_stage: r.hubspot_stage.trim() || null,
      quarter_target: r.kind === 'exit' || target === '' ? null : Number(target),
    };
  });

export const isDirty = (rows: Row[], base: Row[]) => JSON.stringify(toEdits(rows)) !== JSON.stringify(toEdits(base));

/** A new stage goes just before the won stage; a new exit goes last. */
export function addRow(rows: Row[], kind: 'flow' | 'exit'): Row[] {
  const row: Row = { id: localId(), key: null, was: null, name: '', description: '', kind, trigger: 'by_hand', hubspot_stage: '', quarter_target: '', locked: null };
  if (kind === 'exit') return [...rows, row];
  const won = rows.findIndex((r) => r.locked === 'won');
  const at = won === -1 ? rows.findIndex((r) => r.kind === 'exit') : won;
  const copy = [...rows];
  copy.splice(at === -1 ? copy.length : at, 0, row);
  return copy;
}

/** Swaps a row with its neighbour of the same kind; the first and won stages never move. */
export function moveRow(rows: Row[], index: number, by: -1 | 1): Row[] {
  const other = index + by;
  const a = rows[index];
  const b = rows[other];
  if (!a || !b || a.kind !== b.kind || a.locked || b.locked) return rows;
  const copy = [...rows];
  copy[index] = b;
  copy[other] = a;
  return copy;
}

/** Can this row move that way? Same rule as `moveRow`. */
export const canMove = (rows: Row[], index: number, by: -1 | 1) => moveRow(rows, index, by) !== rows;

/**
 * Is a trigger open to this row? A locked row's trigger is fixed; "first" and "won" triggers belong to
 * those rows alone; "one" triggers are taken once another row has them.
 */
export function triggerOpen(trigger: Trigger, row: Row, rows: Row[]): boolean {
  if (trigger.key === row.trigger) return true;
  if (row.locked) return false;
  if (trigger.limit === 'first' || trigger.limit === 'won') return false;
  if (trigger.limit === 'one') return !rows.some((r) => r !== row && r.trigger === trigger.key);
  return true;
}

/** The API's errors by row and field: `stages.{i}.{field}` at the field, the rest for the whole form. */
export function errorsByField(errors: { path: string; message: string }[]) {
  const fields = new Map<string, string[]>();
  const rest: { path: string; message: string }[] = [];
  for (const e of errors) {
    const m = e.path.match(/^stages\.(\d+)(?:\.(\w+))?$/);
    if (!m) {
      rest.push(e);
      continue;
    }
    const k = `${m[1]}.${m[2] ?? ''}`;
    fields.set(k, [...(fields.get(k) ?? []), e.message]);
  }
  return { fields, rest };
}
