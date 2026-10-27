// Match total: the weighted blend of fit and intent (SCO-E1).

import type { ScoringProfile } from '../contracts/types';

/** Signals cannot lift a poor fit: below this fit the total never exceeds fit. */
const POOR_FIT = 50;

export function matchTotal(fit: number, intent: number, profile: ScoringProfile): { total: number; cappedAtFit: boolean } {
  const weights = profile.fitWeight + profile.intentWeight || 1;
  const blend = Math.round((fit * profile.fitWeight + intent * profile.intentWeight) / weights);
  const cappedAtFit = fit < POOR_FIT && blend > fit;
  return { total: cappedAtFit ? fit : blend, cappedAtFit };
}
