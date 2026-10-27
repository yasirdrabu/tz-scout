const KEYS = ['customer_referral', 'partner_referral', 'board_or_investor', 'employee_network', 'event_meeting', 'other'];

/** Keyword rules in order. The first match wins. */
const RULES: [RegExp, string][] = [
  [/\bcustomers?\b/, 'customer_referral'],
  [/\bpartners?\b/, 'partner_referral'],
  [/\b(board|investors?)\b/, 'board_or_investor'],
  [/\b(met at|events?|conferences?)\b/, 'event_meeting'],
  [/\b(knows?|knew|friends?|former colleagues?)\b/, 'employee_network'],
];

/** A relationship key from free text: an exact key first, then keyword rules. Null means ask the AI task, else `other`. */
export function relationshipKey(text: string | null | undefined): string | null {
  const t = text?.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  const exact = t.replace(/ /g, '_');
  if (KEYS.includes(exact)) return exact;
  return RULES.find(([re]) => re.test(t))?.[1] ?? null;
}

type PointsInput = { relationshipKey: string; introducerRule?: number; defaults: Record<string, number> };

/** The full points of an intro: the introducer's rule, else the relationship default; 0 to 20. */
export function warmIntroFullPoints(a: PointsInput): number {
  const base = a.introducerRule ?? a.defaults[a.relationshipKey] ?? a.defaults.other ?? 0;
  return Math.min(20, Math.max(0, Math.round(base)));
}

/** The points that count: the full points, or half (rounded down) until confirmed. */
export function warmIntroPoints(a: PointsInput & { confirmed: boolean }): number {
  const full = warmIntroFullPoints(a);
  return a.confirmed ? full : Math.floor(full / 2);
}

/** The intro with the most effective points. Intros are never added together. */
export function strongest<T extends { effectivePoints: number }>(intros: readonly T[]): T | null {
  return intros.reduce<T | null>((best, i) => (best === null || i.effectivePoints > best.effectivePoints ? i : best), null);
}

/** A person, or a person source's key with `warm_intro:declare`, confirms their own intro. An agent or vendor does not. */
export function isConfirmed(a: { declaredBy: 'person' | 'person_key' | 'agent' | 'vendor' }): boolean {
  return a.declaredBy === 'person' || a.declaredBy === 'person_key';
}
