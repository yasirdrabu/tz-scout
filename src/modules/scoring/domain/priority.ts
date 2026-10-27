// Priority: match total plus warm intro points and the trust modifier (SCO-E2).

import type { ScoringProfile, Tier } from '../contracts/types';

/** Rounds half away from zero and never returns -0. */
const roundHalfAway = (n: number) => Math.sign(n) * Math.round(Math.abs(n)) + 0;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function priority(
  input: { matchTotal: number; finalTier: Tier; warmPoints: number; trust: number | null },
  profile: ScoringProfile,
): { priority: number; warmPoints: number; trustModifier: number } {
  if (input.finalTier === 'not_fit') return { priority: clamp(input.matchTotal, 0, 100), warmPoints: 0, trustModifier: 0 };
  const warmPoints = clamp(input.warmPoints, 0, profile.warmIntroCap);
  const trustModifier =
    input.trust === null
      ? 0
      : clamp(roundHalfAway((input.trust - profile.trustNeutral) * 25), -profile.trustModifierMax, profile.trustModifierMax) + 0;
  return { priority: clamp(input.matchTotal + warmPoints + trustModifier, 0, 100), warmPoints, trustModifier };
}
