// Name rules: splitting a person's name, matching company names, similarity and region keys. Pure.

export function splitName(full: string): { firstName: string; lastName: string | null } {
  const [first = '', ...rest] = full.trim().split(/\s+/);
  return { firstName: first, lastName: rest.length ? rest.join(' ') : null };
}

const LEGAL_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'corp', 'co', 'gmbh']);

/** Key for comparing company names: lowercase, punctuation as spaces, no trailing legal suffix. */
export function matchName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  return words.join(' ');
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** pg_trgm `similarity()`: shared trigrams over all trigrams, each word padded with two spaces before and one after. */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME',
  maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN',
  texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY',
};
const US_NAMES = new Set(['us', 'usa', 'united states', 'united states of america']);

/** `US-FL` for Florida or FL; other countries `<COUNTRY>-<REGION>` upper-cased; null when either is missing. */
export function regionKey(country: string | null | undefined, region: string | null | undefined): string | null {
  const c = country?.trim();
  const r = region?.trim();
  if (!c || !r) return null;
  if (US_NAMES.has(c.toLowerCase())) {
    return `US-${US_STATES[r.toLowerCase()] ?? r.toUpperCase()}`;
  }
  return `${c.toUpperCase()}-${r.toUpperCase()}`;
}
