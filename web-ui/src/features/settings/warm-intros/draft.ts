import type { Introducer, Rule, WarmIntrosEdit, WarmIntrosView } from './api';

// The editor's working copy. Rules keep their place in the list the save sends, so an error's
// `rules[{i}]` path is the row's place in it. Each rule has a local id for React keys.

export type RuleRow = {
  id: string;
  /** The stored rule's id (null for a new one). */
  key: string | null;
  /** '' = nobody picked yet; OTHER = "Someone else" typed in; otherwise the picked person's value. */
  pick: string;
  user_id: string | null;
  email: string;
  name: string;
  relationship_key: string;
  points: string;
  intro_count: number;
};

export type Draft = { relationships: { key: string; label: string; points: string; intro_count: number }[]; rules: RuleRow[] };

export const OTHER = 'other';

let next = 0;
const localId = () => `new-${++next}`;

const toRule = (r: Rule): RuleRow => ({
  id: r.id,
  key: r.id,
  pick: r.introducer_user_id ? `u:${r.introducer_user_id}` : `e:${r.introducer_email ?? ''}`,
  user_id: r.introducer_user_id,
  email: r.introducer_email ?? '',
  name: r.introducer_name ?? '',
  relationship_key: r.relationship_key,
  points: String(r.points),
  intro_count: r.intro_count,
});

export const toDraft = (view: WarmIntrosView): Draft => ({
  relationships: view.relationships.map((r) => ({ ...r, points: String(r.points) })),
  rules: view.rules.map(toRule),
});

/** How a person is shown: name and email, or whichever there is. */
export const personLabel = (p: { name: string | null; email: string | null }) => (p.name && p.email ? `${p.name} · ${p.email}` : (p.name ?? p.email ?? 'Unknown'));

export const introducerValue = (i: Introducer) => (i.user_id ? `u:${i.user_id}` : `e:${i.email ?? ''}`);

/** A new rule: nobody picked, no points yet. */
export const newRule = (relationshipKey: string): RuleRow => ({
  id: localId(),
  key: null,
  pick: '',
  user_id: null,
  email: '',
  name: '',
  relationship_key: relationshipKey,
  points: '',
  intro_count: 0,
});

/** Picks a person from the list (or "Someone else"), filling the row's identity from it. */
export function pickPerson(row: RuleRow, value: string, people: Introducer[]): RuleRow {
  if (value === OTHER || value === '') return { ...row, pick: value, user_id: null, email: '', name: '' };
  const p = people.find((i) => introducerValue(i) === value);
  return { ...row, pick: value, user_id: p?.user_id ?? null, email: p?.email ?? '', name: p?.name ?? '' };
}

/** What the row is called in labels: a stored rule by its person, a new one by its place (never by text being typed). */
export const ruleName = (r: RuleRow, index: number) => (r.key ? r.name.trim() || r.email.trim() || 'this rule' : `the new rule, rule ${index + 1}`);

export const isWholePoints = (p: string) => /^\d+$/.test(p.trim()) && Number(p.trim()) <= 20;

export const POINTS_MESSAGE = 'Points must be a whole number from 0 to 20.';
export const PERSON_MESSAGE = "Enter the person's name and email.";

/**
 * The client's own checks to show, by place: `relationships.{i}.points`, `rules.{i}.points`, `rules.{i}.person`.
 * A new rule's blank points and missing person show only after a save attempt.
 */
export function check(d: Draft, attempted: boolean): Map<string, string> {
  const out = new Map<string, string>();
  d.relationships.forEach((r, i) => {
    if (!isWholePoints(r.points)) out.set(`relationships.${i}.points`, POINTS_MESSAGE);
  });
  d.rules.forEach((r, i) => {
    if (!isWholePoints(r.points) && (attempted || r.key || r.points.trim() !== '')) out.set(`rules.${i}.points`, POINTS_MESSAGE);
    if (!attempted || r.key) return;
    const typed = r.name.trim() !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email.trim());
    if (r.pick === '' || (r.pick === OTHER && !typed)) out.set(`rules.${i}.person`, PERSON_MESSAGE);
  });
  return out;
}

export function toEdit(d: Draft): WarmIntrosEdit {
  return {
    relationships: d.relationships.map((r) => ({ key: r.key, points: Number(r.points.trim()) })),
    rules: d.rules.map((r) => ({
      ...(r.key ? { id: r.key } : {}),
      ...(r.user_id ? { introducer_user_id: r.user_id } : { introducer_email: r.email.trim(), introducer_name: r.name.trim() }),
      relationship_key: r.relationship_key,
      points: Number(r.points.trim()),
    })),
  };
}

export const isDirty = (d: Draft, base: Draft) => JSON.stringify(toEdit(d)) !== JSON.stringify(toEdit(base));

/** The API's errors by place: `rules[2].points` at the row's field, the rest for the whole form. */
export function errorsByField(errors: { path: string; message: string }[]) {
  const fields = new Map<string, string[]>();
  const rest: { path: string; message: string }[] = [];
  for (const e of errors) {
    const m = e.path.match(/^(rules|relationships)(?:\[(\d+)\]|\.(\d+))(?:\.(\w+))?$/);
    const field = m?.[4] ?? '';
    const place = field.startsWith('introducer_') ? 'person' : field === 'key' ? 'relationship_key' : field;
    // Only the places the tables show; anything else goes to the banner.
    if (!m || !['points', 'person', 'relationship_key', 'id'].includes(place)) {
      rest.push(e);
      continue;
    }
    const k = `${m[1]}.${m[2] ?? m[3]}.${place}`;
    fields.set(k, [...(fields.get(k) ?? []), e.message]);
  }
  return { fields, rest };
}
