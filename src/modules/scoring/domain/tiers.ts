// Tier of one offer match, and the floors applied to the account's tier (SCO-E3).

import { TIERS, type ScoringProfile, type Tier, type TierReason } from '../contracts/types';

const DAY_MS = 86_400_000;
const WARM_INTRO_MIN_FIT = 40;
const TIER_LABEL: Record<Tier, string> = { not_fit: 'not a fit', watch: 'watch', good_fit: 'good fit', act_now: 'act now' };

export type TierInput = {
  fit: number;
  intent: number;
  total: number;
  disqualifiedReason: string | null;
  /** At least one research or trigger signal hit; pain alone is not a reason to act now. */
  hasResearchOrTrigger: boolean;
};

export function tierFor(input: TierInput, profile: ScoringProfile): Tier {
  const { notFitBelow, actNow, goodFit } = profile.tierThresholds;
  if (input.disqualifiedReason !== null || input.fit < notFitBelow) return 'not_fit';
  if (input.fit >= actNow.fit && input.intent >= actNow.intent && input.total >= actNow.total && input.hasResearchOrTrigger) return 'act_now';
  if (input.fit >= goodFit.fit) return 'good_fit';
  return 'watch';
}

export type ResearchTier = 'A' | 'B' | 'C';

export type FloorInput = {
  disqualified: boolean;
  researchTier: ResearchTier | null;
  researchSignalAt: Date | null;
  warmIntro: boolean;
  bestFit: number;
};

const higher = (a: Tier, b: Tier) => TIERS.indexOf(b) > TIERS.indexOf(a);

/** The higher of the computed tier and any floor wins. Floors change the tier, never the priority number. */
export function applyFloors(
  computed: Tier,
  input: FloorInput,
  profile: ScoringProfile,
  now: Date,
): { tier: Tier; tierReason: TierReason; text?: string } {
  if (input.disqualified) return { tier: computed, tierReason: 'computed' };
  let tier = computed;
  let tierReason: TierReason = 'computed';
  let text: string | undefined;

  if (input.researchTier) {
    const recent = input.researchSignalAt !== null && (now.getTime() - input.researchSignalAt.getTime()) / DAY_MS <= profile.researchFloorDays;
    const floor: Tier = input.researchTier === 'A' ? (recent ? 'act_now' : 'good_fit') : input.researchTier === 'B' ? 'good_fit' : 'watch';
    if (higher(tier, floor)) {
      const since = input.researchSignalAt ? ` with a signal from ${input.researchSignalAt.toISOString().slice(0, 10)}` : '';
      tier = floor;
      tierReason = 'research_floor';
      text = `Researcher rated ${input.researchTier}${since}: ${TIER_LABEL[floor]}`;
    }
  }
  if (input.warmIntro && input.bestFit >= WARM_INTRO_MIN_FIT && higher(tier, 'good_fit')) {
    tier = 'good_fit';
    tierReason = 'warm_intro_floor';
    text = undefined;
  }
  return text === undefined ? { tier, tierReason } : { tier, tierReason, text };
}
