// Public interface of the scoring module. Other modules import only this file or `contracts/*`.
export { accountScored, rulesChanged } from './contracts/events';
export { ageingJob, rescoreAccountsJob, rescorePageJob, type RescoreFilter } from './contracts/jobs';
export {
  SCORE_CAUSES,
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
export { requestRescore } from './services/rescore';
export { scoreAccount, type AccountScore, type ScoreOptions } from './services/score';
export { getMatches, getScore, getScoreHistory, type OfferMatchView, type ScoreChangeView } from './services/read';
export { explainScore, type ScoreExplanation } from './services/explain';
export { causeInWords } from './domain/explain';
