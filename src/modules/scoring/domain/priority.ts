// Priority: match score plus warm intro points (SCO-E6).

import type { ScoringProfile, Tier } from '../contracts/types';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function priority(
  input: { score: number; finalTier: Tier; warmPoints: number },
  profile: ScoringProfile,
): { priority: number; warmPoints: number } {
  if (input.finalTier === 'not_fit') return { priority: clamp(input.score, 0, 100), warmPoints: 0 };
  const warmPoints = clamp(input.warmPoints, 0, profile.warmIntroCap);
  return { priority: clamp(input.score + warmPoints, 0, 100), warmPoints };
}
