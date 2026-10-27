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
export { scoringTenantDefaults } from './consumers';
export { DEFAULT_PROFILE, seedScoringDefaults } from './defaults';
