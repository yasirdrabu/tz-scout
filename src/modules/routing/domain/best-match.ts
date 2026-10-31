// "Best match" in the Assign dialog (Decision 8): the seller whose practice access covers the accounts'
// best offers, fewest active accounts first. No badge when nobody covers them (Open question 7).

export type SellerCandidate = {
  userId: string;
  name: string;
  /** The practices their data limit names; `all` when it covers every practice. */
  practices: string[] | 'all';
  activeAccounts: number;
  /** Without a HubSpot user Scout can't make them the owner, so they can't be picked. */
  crmOwnerLinked: boolean;
};

export type BestMatch = { userId: string; reason: string } | null;

const covers = (s: SellerCandidate, practiceIds: string[]) => s.practices === 'all' || practiceIds.every((p) => (s.practices as string[]).includes(p));

/** Joins names the way the reason line says them: "A", "A and B", "A, B and C". */
const andList = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * The best match for accounts whose best offers are in `practiceIds` (named by `practiceName`). None when
 * an account has no best offer (`practiceIds` empty) or no pickable seller covers every practice.
 */
export function bestMatch(sellers: SellerCandidate[], practiceIds: string[], practiceName: (id: string) => string): BestMatch {
  const needed = [...new Set(practiceIds)];
  if (needed.length === 0) return null;
  const [best] = sellers
    .filter((s) => s.crmOwnerLinked && covers(s, needed))
    .sort((a, b) => a.activeAccounts - b.activeAccounts || a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  if (!best) return null;
  return { userId: best.userId, reason: `Covers ${andList(needed.map(practiceName))} and has the fewest active accounts (${best.activeAccounts}).` };
}
