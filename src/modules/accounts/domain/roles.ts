// Buying roles guessed from a job title. Pure: the caller keeps only the tenant's active roles.

// "president" is not "vice president": that one is a business function head.
const COMMERCIAL = ['cfo', 'chief financial', 'owner', '(?<!vice )president', 'ceo', 'chief executive', 'finance director', 'controller'];
const TECHNICAL = [
  'cio', 'cto', 'ciso', 'chief information', 'chief technology', 'it', 'information technology',
  'engineering', 'security', 'data', 'technology', 'infrastructure',
];
const PROCUREMENT = ['procurement', 'purchasing', 'contracts', 'buyer', 'sourcing'];
const BUSINESS = ['chief', 'vp', 'vice president', 'head of', 'director'];

const matcher = (words: string[]) => new RegExp(`\\b(?:${words.join('|')})\\b`);
const RULES: [string, RegExp][] = [
  ['commercial_buyer', matcher(COMMERCIAL)],
  ['technical_buyer', matcher(TECHNICAL)],
  ['procurement', matcher(PROCUREMENT)],
];
const BUSINESS_OWNER = matcher(BUSINESS);

/** Roles a title suggests, case-insensitive on word boundaries. `business_owner` only when no other rule matched. */
export function guessRolesFromTitle(title: string | null | undefined): string[] {
  const t = (title ?? '').toLowerCase().replace(/[&,]/g, ' ');
  if (!t.trim()) return [];
  const roles = RULES.filter(([, re]) => re.test(t)).map(([key]) => key);
  if (!roles.length && BUSINESS_OWNER.test(t)) roles.push('business_owner');
  return roles;
}
