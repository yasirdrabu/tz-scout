// Match score: the weighted blend of the four scores (SCO-E6).

import type { ScoringProfile } from '../contracts/types';

/** Signals, size or trust cannot lift a poor fit: below this fit the score never exceeds fit. */
const POOR_FIT = 50;

export function matchScore(
  s: { fit: number; intent: number; revenue: number; trust: number },
  profile: ScoringProfile,
): { score: number; cappedAtFit: boolean } {
  const w = profile.weights;
  const blend = Math.round((w.fit * s.fit + w.intent * s.intent + w.revenue * s.revenue + w.trust * s.trust) / 100);
  const cappedAtFit = s.fit < POOR_FIT && blend > s.fit;
  return { score: cappedAtFit ? s.fit : blend, cappedAtFit };
}
