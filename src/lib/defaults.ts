// Company defaults stored in Settings on creation. Every value is editable in Settings.
// These are starting assumptions until Phase 0 and real history replace them.

import { DEFAULT_WEIGHTS } from "./scoring";
import type { FunnelRates } from "./funnel";
import type { ScorecardConfig } from "./scorecard";

export type TestDefaults = { channel: "meta" | "linkedin"; budgetCents: number; durationHours: number; targetCtr: number; targetCpcCents: number; minImpressions: number; statementCount: number };
export type FunnelDefaults = FunnelRates & { dealValueCents: number; margin: number; targetWonPerMonth: number; budgetCents: number };
export type SequenceSettings = { reminderHours: number[]; rebookDays: number[]; bookingLinkDelayMinutes: number; smsReminders: boolean };

export const DEFAULT_TEST: TestDefaults = { channel: "meta", budgetCents: 30000, durationHours: 72, targetCtr: 0.01, targetCpcCents: 350, minImpressions: 1000, statementCount: 12 };

export const DEFAULT_FUNNEL: FunnelDefaults = {
  cpmCents: 3000,
  ctr: 0.012,
  formRate: 0.035,
  validationRate: 0.5,
  discoveryShowRate: 0.7,
  qualificationRate: 0.45,
  salesShowRate: 0.85,
  closeRate: 0.3,
  dealValueCents: 1_000_000,
  margin: 0.55,
  targetWonPerMonth: 3,
  budgetCents: 1_500_000,
};

export const DEFAULT_SEQUENCE: SequenceSettings = { reminderHours: [24, 1], rebookDays: [0, 3, 7], bookingLinkDelayMinutes: 0, smsReminders: true };

/** Weekly targets. Money in cents, rates as decimals. minSample = smallest denominator worth colouring. */
export const DEFAULT_SCORECARD: ScorecardConfig = {
  spend: { target: 300000 },
  impressions: { target: 95000 },
  cpm: { target: 3200, minSample: 1000 },
  clicks: { target: 1100 },
  ctr: { target: 0.011, minSample: 1000 },
  cpc: { target: 280, minSample: 50 },
  formFills: { target: 50 },
  formRate: { target: 0.035, minSample: 100 },
  costPerFormFill: { target: 7000, minSample: 5 },
  validatedLeads: { target: 25 },
  validationRate: { target: 0.5, minSample: 10 },
  costPerValidated: { target: 14000, minSample: 5 },
  discoveryHeld: { target: 14 },
  discoveryShowRate: { target: 0.7, minSample: 5 },
  costPerDiscovery: { target: 25000, minSample: 3 },
  qualified: { target: 6 },
  qualificationRate: { target: 0.45, minSample: 5 },
  costPerQualified: { target: 55000, minSample: 2 },
  salesHeld: { target: 5 },
  salesShowRate: { target: 0.85, minSample: 3 },
  costPerSalesCall: { target: 65000, minSample: 2 },
  won: { target: 2 },
  closeRate: { target: 0.3, minSample: 3 },
  costPerWon: { target: 200000, minSample: 1 },
  revenue: { target: 2500000 },
};

export function defaultSettings() {
  return {
    weights: DEFAULT_WEIGHTS,
    maxActiveSegments: 3,
    testDefaults: DEFAULT_TEST,
    funnelDefaults: DEFAULT_FUNNEL,
    sequence: DEFAULT_SEQUENCE,
    scorecard: DEFAULT_SCORECARD,
  };
}
