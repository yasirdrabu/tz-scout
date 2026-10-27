// Public interface of the accounts module. Other modules import only this file or `contracts/*`.
export { accountsTenantDefaults } from './consumers';
export { DEFAULT_BUYING_ROLES, DEFAULT_EXCLUSION_RULES, VENDOR_PHRASES, seedAccountDefaults } from './defaults';
export {
  mergeGuard,
  registerMergeGuard,
  registerSourceAccessProvider,
  registerSourceInfoProvider,
  sourceAccessProvider,
  sourceInfoProvider,
  type MergeGuard,
  type SourceAccessProvider,
  type SourceInfoProvider,
} from './contracts/ports';
export { FACT_KEYS, isKnownFactKey } from './contracts/types';
export {
  archiveSignal,
  convertShell,
  editAccount,
  editPerson,
  overrideExclusion,
  pinPrimary,
  removeExclusionOverride,
  type AccountPatch,
  type PersonPatch,
} from './services/edit';
export type { Exclusion } from './services/exclusion';
export { findMatches, resolveAccountId, type AccountMatch, type MatchCandidate, type MatchConfidence } from './services/match';
export {
  checkExclusion,
  getAccount,
  getAccountForScoring,
  getAccounts,
  getFacts,
  getSignals,
  listPeople,
  type ScoringView,
} from './services/read';
export { mergeAccounts } from './services/merge';
export { setPractices } from './services/practices';
export { upsertFromArrival, type UpsertResult } from './services/upsert';
export type {
  AccountView,
  ArrivalForAccounts,
  FactView,
  PersonView,
  SignalView,
  SourceChain,
} from './contracts/types';
