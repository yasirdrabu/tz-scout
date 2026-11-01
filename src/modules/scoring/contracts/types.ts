import { z } from 'zod';

export const SCORE_CAUSES = ['new_signal', 'new_fact', 'rules_changed', 'offer_changed', 'trust_changed', 'warm_intro', 'manual_rescore', 'ageing', 'tier_override'] as const;
export const scoreCauseSchema = z.enum(SCORE_CAUSES);
export type ScoreCause = z.infer<typeof scoreCauseSchema>;

export const TIERS = ['not_fit', 'nurture', 'watch', 'good_fit', 'act_now'] as const;
export const tierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof tierSchema>;

/** The tier names people see, best first ("Tier names come from the API"). */
export const TIER_NAMES: Record<Tier, string> = { act_now: 'Act now', good_fit: 'Good fit', watch: 'Watch', nurture: 'Nurture', not_fit: 'Not a fit' };

/** One offer's score for an account, as the best-offer pick and priority read it. */
export type Match = { offerId: string; fit: number; intent: number; score: number; tier: Tier };

export const TIER_REASONS = ['computed', 'research_floor', 'warm_intro_floor'] as const;
export type TierReason = (typeof TIER_REASONS)[number];

export const revenueBandSchema = z.enum(['low', 'medium', 'high']);
export type RevenueBand = z.infer<typeof revenueBandSchema>;

export const fitPartsSchema = z.object({
  industry: z.number(),
  size: z.number(),
  revenue: z.number(),
  region: z.number(),
  buyer: z.number(),
});
export type FitParts = z.infer<typeof fitPartsSchema>;

/** The four scores' weights, whole numbers adding to 100 (SCO-E6). */
export const weightsSchema = z.object({ fit: z.number(), intent: z.number(), revenue: z.number(), trust: z.number() });
export type Weights = z.infer<typeof weightsSchema>;

/** The lowest score each tier starts at; Nurture is everything below `watch`. */
export const tierCutoffsSchema = z.object({ actNow: z.number(), goodFit: z.number(), watch: z.number() });
export type TierCutoffs = z.infer<typeof tierCutoffsSchema>;

/** The tenant's scoring settings as the pure functions read them. */
export type ScoringProfile = {
  weights: Weights;
  fitParts: FitParts;
  halfLifeDays: number;
  maxSignalAgeDays: number;
  tierCutoffs: TierCutoffs;
  warmIntroCap: number;
  trustNeutral: number;
  researchFloorDays: number;
};

export type ScoringPerson = { title: string | null; roleKeys: string[] };

export type ScoringAccount = {
  domain: string;
  industry: string | null;
  industryKey: string | null;
  employees: number | null;
  revenueCents: number | null;
  country: string | null;
  technologies: string[];
  headcountGrowth6m: number | null;
  /** Why this account is ruled out for every offer, when it is and no person has overridden that. */
  excluded: { label: string } | null;
  people: ScoringPerson[];
};

export type ScoringSignalKind = 'research' | 'trigger' | 'pain';

export type ScoringSignal = {
  id: string;
  type: string | null;
  kind: ScoringSignalKind;
  title: string;
  detail: string | null;
  value: number | null;
  occurredAt: Date | null;
  recordedAt: Date;
};

/** One signal rule of an offer. `minValue` is a decimal such as 0.6 for a research score or 0.1 for growth. */
export type ScoringRule = {
  id: string;
  type: string;
  label: string;
  weight: number;
  match: string[];
  minValue: number | null;
  why: string | null;
  enabled: boolean;
};

export type ScoringOffer = {
  id: string;
  industries: string[];
  excludedCategories: string[];
  excludedDomains: string[];
  companySizeMin: number | null;
  companySizeMax: number | null;
  revenueMinCents: number | null;
  revenueMaxCents: number | null;
  regions: string[];
  targetTitles: string[];
  targetBuyingRoles: string[];
  rules: ScoringRule[];
};

export type FitPartKey = keyof FitParts;
/** `unknown` is true when the account has no value for this part, so it earned a middle share. */
export type FitPart = { key: FitPartKey; label: string; points: number; max: number; note: string; unknown: boolean };

export type RuleHit = {
  ruleId: string;
  label: string;
  type: string;
  kind: ScoringSignalKind;
  points: number;
  max: number;
  signalIds: string[];
  matched: string[];
  why: string | null;
};
