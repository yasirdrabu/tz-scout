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

/** Nulls any target outside the allowed list, and leaves columns under the confidence floor unmapped. */
export function cleanMapping(out: MappingOutput): MappingOutput {
  return {
    columns: out.columns.map((c) =>
      c.target !== null && isAllowedTarget(c.target) && c.confidence >= MIN_CONFIDENCE ? c : { ...c, target: null },
    ),
  };
}
