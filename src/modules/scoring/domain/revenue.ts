// Revenue potential score: what the offer could be worth at this account (SCO-E6).

import type { RevenueBand, ScoringProfile } from '../contracts/types';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export type RevenueInput = {
  typicalDealCents: number | null;
  priceMinCents: number | null;
  expansionRate: number | null;
  sizeMin: number | null;
  sizeMax: number | null;
  employees: number | null;
  /** Median won deal in the offer's practice when it has 5 or more wins. Null means the offer's base. */
  referenceCents: number | null;
};

export type RevenueResult = { score: number; cents: number | null; band: RevenueBand | null; reason: string | null };

/** 0.75 below the size range midpoint, 1.5 above its maximum, otherwise (or when unknown) 1. */
function sizeFactor(employees: number | null, min: number | null, max: number | null): number {
  if (employees === null) return 1;
  if (max !== null && employees > max) return 1.5;
  const low = min !== null && max !== null ? (min + max) / 2 : min;
  return low !== null && employees < low ? 0.75 : 1;
}

export function revenuePotential(input: RevenueInput): RevenueResult {
  const base = input.typicalDealCents ?? input.priceMinCents;
  if (base === null || base <= 0) return { score: 50, cents: null, band: null, reason: 'no_deal_size' };
  const cents = Math.round(base * sizeFactor(input.employees, input.sizeMin, input.sizeMax) + base * (input.expansionRate ?? 0));
  const reference = input.referenceCents !== null && input.referenceCents > 0 ? input.referenceCents : base;
  const score = clamp(Math.round((50 * cents) / reference), 0, 100);
  return { score, cents, band: score >= 100 ? 'high' : score >= 38 ? 'medium' : 'low', reason: null };
}

/** Source trust as a score out of 100; an account with no trusted source gets the neutral value. */
export function trustScore(trust: number | null, profile: ScoringProfile): number {
  return Math.round((trust ?? profile.trustNeutral) * 100);
}
