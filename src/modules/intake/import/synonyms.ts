import { z } from 'zod';

/** What a file column can map to. Everything else is dropped. */
const FIXED_TARGETS = new Set([
  'account.name',
  'account.website',
  'account.domain',
  'account.linkedin_url',
  'account.country',
  'account.region',
  'account.city',
  'account.industry',
  'account.employees',
  'account.notes',
  'account.practice_hint',
  'account.external_ref',
]);
const TARGET_PATTERNS = [
  /^people\[\d+\]\.(first_name|last_name|name|email|title|phone|linkedin_url)$/,
  /^signals\[\]\.(occurred_at|title|url|type)$/,
  /^research\.[a-z_]+$/,
  /^account\.custom_fields\.[A-Za-z0-9_]+$/,
];
export const isAllowedTarget = (t: string): boolean => FIXED_TARGETS.has(t) || TARGET_PATTERNS.some((re) => re.test(t));

/** Columns under this confidence are left unmapped. */
export const MIN_CONFIDENCE = 0.6;

export const mappingInput = z.object({
  headers: z.array(z.string()).max(200),
  sampleRows: z.array(z.array(z.string())).max(5),
});
export const mappingColumn = z.object({
  header: z.string(),
  target: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
export const mappingOutput = z.object({ columns: z.array(mappingColumn) });
export type MappingInput = z.infer<typeof mappingInput>;
export type MappingColumn = z.infer<typeof mappingColumn>;
export type MappingOutput = z.infer<typeof mappingOutput>;

// The lead-sheet header guesses, pointed at arrival.v1 paths.
const SYNONYMS: [target: string, aliases: string[]][] = [
  ['account.name', ['company', 'company name', 'organization', 'organisation', 'account', 'account name', 'employer', 'business']],
  ['account.website', ['website', 'url', 'company website', 'web', 'site', 'company url']],
  ['account.domain', ['domain', 'company domain']],
  ['people[0].name', ['name', 'full name', 'contact', 'contact name', 'attendee', 'person']],
  ['people[0].first_name', ['first name', 'first', 'firstname', 'given name']],
  ['people[0].last_name', ['last name', 'last', 'lastname', 'surname', 'family name']],
  ['people[0].title', ['title', 'job title', 'position', 'role', 'job']],
  ['people[0].email', ['email', 'email address', 'work email', 'e-mail', 'business email']],
  ['people[0].phone', ['phone', 'phone number', 'mobile', 'cell', 'direct', 'telephone']],
  ['people[0].linkedin_url', ['linkedin', 'linkedin url', 'linkedin profile', 'li']],
  ['account.industry', ['industry', 'sector', 'vertical']],
  ['account.employees', ['employees', 'employee count', 'company size', 'headcount', 'size', '# employees']],
  ['account.city', ['city', 'town']],
  ['account.region', ['state', 'region', 'province']],
  ['account.country', ['country']],
  ['account.notes', ['notes', 'note', 'comments', 'comment', 'context', 'conversation']],
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();

/** Header guesses: an exact alias first (0.9), then a header that contains an alias, longest alias winning (0.7). Each target is used once. */
export function synonymMapping(input: MappingInput): MappingOutput {
  const H = input.headers.map(norm);
  const found = new Map<number, { target: string; confidence: number }>();
  const taken = new Set<string>();
  for (const pass of ['exact', 'contains'] as const) {
    H.forEach((h, i) => {
      if (found.has(i)) return;
      let best: { target: string; len: number } | null = null;
      for (const [target, aliases] of SYNONYMS) {
        if (taken.has(target)) continue;
        for (const a of aliases) {
          const hit = pass === 'exact' ? h === a : h.includes(a) && a.length > 3;
          if (hit && (!best || a.length > best.len)) best = { target, len: a.length };
        }
      }
      if (!best) return;
      found.set(i, { target: best.target, confidence: pass === 'exact' ? 0.9 : 0.7 });
      taken.add(best.target);
    });
  }
  return {
    columns: input.headers.map((header, i) => {
      const f = found.get(i);
      return f
        ? { header, target: f.target, confidence: f.confidence, reason: 'The header matches a known name for this field.' }
        : { header, target: null, confidence: 0, reason: 'No known name matches this header.' };
    }),
  };
}

/**
 * Nulls any target outside the allowed list, and leaves columns under the confidence floor unmapped.
 * A target takes one column: the highest confidence wins and a tie goes to the first header. The one
 * exception is `signals[].*`, which is repeatable (each column can make its own signal), so it is not deduplicated.
 * `people[n]` and `account.custom_fields.<key>` are single-valued per path.
 */
export function cleanMapping(out: MappingOutput): MappingOutput {
  const ok = out.columns.map((c) => c.target !== null && isAllowedTarget(c.target) && c.confidence >= MIN_CONFIDENCE);
  const winner = new Map<string, number>();
  out.columns.forEach((c, i) => {
    if (!ok[i] || c.target!.startsWith('signals[]')) return;
    const w = winner.get(c.target!);
    if (w === undefined || c.confidence > out.columns[w]!.confidence) winner.set(c.target!, i);
  });
  return {
    columns: out.columns.map((c, i) =>
      ok[i] && (c.target!.startsWith('signals[]') || winner.get(c.target!) === i) ? c : { ...c, target: null },
    ),
  };
}

/**
 * The Scout fields a column can map to, in the order the Match step lists them (§15): the common ones first, then
 * "Don't import" (`key: null`), then the rest. The API owns the words (C8).
 */
export const IMPORT_TARGETS: { key: string | null; label: string }[] = [
  { key: 'account.name', label: 'Company name' },
  { key: 'account.website', label: 'Website' },
  { key: 'account.city', label: 'Location' },
  { key: 'people[0].name', label: 'Person name' },
  { key: 'people[0].title', label: 'Job title' },
  { key: 'people[0].email', label: 'Email' },
  { key: 'people[0].phone', label: 'Phone' },
  { key: 'account.notes', label: 'Notes' },
  { key: null, label: "Don't import" },
  { key: 'account.domain', label: 'Domain' },
  { key: 'account.linkedin_url', label: 'Company LinkedIn page' },
  { key: 'account.region', label: 'State or region' },
  { key: 'account.country', label: 'Country' },
  { key: 'account.industry', label: 'Industry' },
  { key: 'account.employees', label: 'Employees' },
  { key: 'account.practice_hint', label: 'Practice' },
  { key: 'account.external_ref', label: 'Your reference' },
  { key: 'people[0].first_name', label: 'First name' },
  { key: 'people[0].last_name', label: 'Last name' },
  { key: 'people[0].linkedin_url', label: 'Person LinkedIn page' },
  { key: 'signals[].title', label: 'Signal' },
  { key: 'signals[].occurred_at', label: 'Signal date' },
  { key: 'signals[].url', label: 'Signal link' },
  { key: 'signals[].type', label: 'Signal type' },
];

const sentence = (s: string) => {
  const t = s.replace(/_/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** The label for a mapping target, including ones outside the list (a custom field, a research field, a second person). */
export function targetLabel(key: string): string {
  const known = IMPORT_TARGETS.find((t) => t.key === key);
  if (known) return known.label;
  const custom = key.match(/^account\.custom_fields\.(.+)$/);
  if (custom) return `Custom field: ${sentence(custom[1]!)}`;
  const research = key.match(/^research\.(.+)$/);
  if (research) return `Research: ${sentence(research[1]!)}`;
  const person = key.match(/^people\[(\d+)\]\.(\w+)$/);
  if (person) return `Person ${Number(person[1]) + 1}: ${sentence(person[2]!).toLowerCase()}`;
  return sentence(key.replace(/^account\./, ''));
}
