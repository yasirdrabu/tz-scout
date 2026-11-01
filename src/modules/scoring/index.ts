// Public interface of the scoring module. Other modules import only this file or `contracts/*`.
export { accountScored, rulesChanged } from './contracts/events';
export { ageingJob, rescoreAccountsJob, rescorePageJob, type RescoreFilter } from './contracts/jobs';
export {
  SCORE_CAUSES,
  TIER_NAMES,
  TIERS,
  type FitParts,
  type RevenueBand,
  type ScoreCause,
  type Tier,
  type TierReason,
  type TierThresholds,
} from './contracts/types';
export { scoringConsumers, scoringTenantDefaults } from './consumers';
export { ageingHandler, rescoreAccountsHandler, rescorePageHandler } from './jobs';
export { DEFAULT_PROFILE, seedScoringDefaults } from './defaults';
export { getProfile, resetProfile, updateProfile, type ProfilePatch, type ProfileView } from './services/profile';
export { lastRescore, type LastRescoreView } from './services/last-rescore';
export { requestRescore } from './services/rescore';
export { scoreAccount, type AccountScore, type ScoreOptions } from './services/score';
export { getMatches, getScore, getScoreHistory, tierDetails, type OfferMatchView, type ScoreChangeView, type TierDetail } from './services/read';
export { explainScore, type ScoreExplanation } from './services/explain';
export { setTierOverride, type TierView } from './services/tier';
export { causeInWords } from './domain/explain';
