import { z } from 'zod';

export const SCORE_CAUSES = ['new_signal', 'new_fact', 'rules_changed', 'offer_changed', 'trust_changed', 'warm_intro', 'manual_rescore'] as const;
export const scoreCauseSchema = z.enum(SCORE_CAUSES);
export type ScoreCause = z.infer<typeof scoreCauseSchema>;

export const TIERS = ['not_fit', 'watch', 'good_fit', 'act_now'] as const;
export const tierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof tierSchema>;

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

export const tierThresholdsSchema = z.object({
  notFitBelow: z.number(),
  actNow: z.object({ fit: z.number(), intent: z.number(), total: z.number() }),
  goodFit: z.object({ fit: z.number() }),
});
export type TierThresholds = z.infer<typeof tierThresholdsSchema>;
