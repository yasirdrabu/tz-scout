export { noteFingerprint } from './fingerprint';

/** HubSpot's limit on a note body, in characters. */
export const NOTE_LIMIT = 65_000;

export type NotePerson = {
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  emailStatus: string | null;
  isPrimary: boolean;
  roles: { key: string }[];
};

export type NoteInput = {
  account: {
    name: string;
    industry: string | null;
    employees: number | null;
    hqCity: string | null;
    hqState: string | null;
    hqCountry: string | null;
    description: string | null;
    technologies: string[];
  };
  people: NotePerson[];
  assignmentNote: string | null;
  ownerLine: string | null;
  scoutUrl: string;
  dataAsOf: Date | null;
  pkg: { sections: { key: string; label: string; html: string }[] } | null;
};

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const heading = (t: string) => `<p><strong>${esc(t)}</strong></p>`;
const words = (key: string) => key.replace(/_/g, ' ');

function personLine(p: NotePerson): string {
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Unnamed contact';
  const bits = [`<strong>${esc(name)}</strong>`];
  if (p.title) bits.push(esc(p.title));
  if (p.email) bits.push(`${esc(p.email)}${p.emailStatus ? ` (${esc(words(p.emailStatus))})` : ''}`);
  if (p.roles.length) bits.push(`Buying role: ${esc(p.roles.map((r) => words(r.key)).join(', '))}`);
  return `<li>${bits.join(', ')}${p.isPrimary ? ' (primary)' : ''}</li>`;
}

type Section = { key: string; html: string };

function accountSections(i: NoteInput): Section[] {
  const out: Section[] = [];
  if (i.people.length) {
    const sorted = [...i.people].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    out.push({ key: 'people', html: `${heading('People')}<ul>${sorted.map(personLine).join('')}</ul>` });
  }
  const a = i.account;
  const location = [a.hqCity, a.hqState, a.hqCountry].filter(Boolean).join(', ');
  const rows = [
    a.description ? `<li>${esc(a.description)}</li>` : '',
    a.industry ? `<li>Industry: ${esc(a.industry)}</li>` : '',
    a.employees != null ? `<li>Size: about ${a.employees.toLocaleString('en-US')} employees</li>` : '',
    location ? `<li>Location: ${esc(location)}</li>` : '',
    a.technologies.length ? `<li>Tech stack: ${esc(a.technologies.join(', '))}</li>` : '',
  ].filter(Boolean);
  if (rows.length) out.push({ key: 'company', html: `${heading(`About ${a.name}`)}<ul>${rows.join('')}</ul>` });
  if (i.dataAsOf) out.push({ key: 'data_as_of', html: `<p>Data as of ${i.dataAsOf.toISOString().slice(0, 10)}</p>` });
  if (i.assignmentNote?.trim()) out.push({ key: 'assignment_note', html: `${heading('Note from the lead')}<p>${esc(i.assignmentNote.trim())}</p>` });
  if (i.ownerLine?.trim()) out.push({ key: 'owner', html: `<p>${esc(i.ownerLine.trim())}</p>` });
  return out;
}

/** The note body. Over NOTE_LIMIT, sections go from the bottom up; the Scout link always stays. */
export function buildNote(input: NoteInput): { html: string; droppedSections: string[] } {
  const url = esc(input.scoutUrl);
  const link = `<p>Open in Scout: <a href="${url}">${url}</a></p>`;
  const more = `<p><em>More in Scout</em></p>`;
  const kept: Section[] = [...(input.pkg?.sections ?? []).map((s) => ({ key: s.key, html: s.html })), ...accountSections(input)];
  const dropped: string[] = [];
  const render = () => kept.map((s) => s.html).join('') + (dropped.length ? more : '') + link;
  while (kept.length > 0 && render().length > NOTE_LIMIT) {
    const last = kept.pop() as Section;
    dropped.unshift(last.key);
  }
  return { html: render(), droppedSections: dropped };
}
