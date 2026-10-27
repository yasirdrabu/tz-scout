// Seniority from a title, for picking who to approach first. Ported from v1 `seniority`, now as categories.

export const SENIORITIES = ['owner', 'founder', 'chief', 'president', 'vp', 'head', 'director', 'manager', 'other'] as const;
export type Seniority = (typeof SENIORITIES)[number];

/** Higher is more senior. Follows the order of SENIORITIES, owner highest. */
export const SENIORITY_RANK: Record<Seniority, number> = Object.fromEntries(
  SENIORITIES.map((s, i) => [s, SENIORITIES.length - 1 - i]),
) as Record<Seniority, number>;

export function isSeniority(value: string | null | undefined): value is Seniority {
  return !!value && (SENIORITIES as readonly string[]).includes(value);
}

export function seniorityFromTitle(title: string | null | undefined): Seniority {
  const t = (title ?? '').toLowerCase();
  if (/\bowner\b/.test(t) && !/\bproduct owner\b/.test(t)) return 'owner';
  if (/\bfounder\b/.test(t)) return 'founder';
  if (/\b(chief|ceo|coo|cio|cto|cfo|ciso|cdo|cmo)\b/.test(t)) return 'chief';
  if (/\bpresident\b/.test(t) && !/\bvice\b/.test(t)) return 'president';
  if (/\b(svp|evp|vp|vice president)\b/.test(t)) return 'vp';
  if (/\bhead\b/.test(t)) return 'head';
  if (/\bdirector\b/.test(t)) return 'director';
  if (/\bmanager\b/.test(t)) return 'manager';
  return 'other';
}
