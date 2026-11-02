// Public interface of the accounts module. Other modules import only this file or `contracts/*`.
export { accountsCrmStatusConsumers, accountsSummaryOnReviewChanged, accountsSummaryOnScored, accountsTenantDefaults } from './consumers';
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
export { SIGNAL_TYPES, type SignalType } from './domain/signals';
export { FACT_KEYS, isKnownFactKey } from './contracts/types';
export { factLabel } from './contracts/fact-labels';
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
export { matchName, splitName, trigramSimilarity } from './domain/names';
export { findMatches, resolveAccountId, type AccountMatch, type MatchCandidate, type MatchConfidence } from './services/match';
export {
  activeAccountIds,
  checkExclusion,
  floorBasics,
  getAccount,
  getAccountForScoring,
  accountNames,
  getAccounts,
  getFacts,
  getPerson,
  getSignal,
  getSignals,
  getSummaries,
  listAccountIds,
  listBuyingRoles,
  listExternalIds,
  listPeople,
  type AccountSummaryView,
  type ExternalIdRow,
  type FloorBasics,
  type ScoringView,
} from './services/read';
export { exclusionsRecheckHandler, exclusionsRecheckJob } from './jobs';
export { mergeAccounts } from './services/merge';
export { countAccounts, countAccountsBy, oldestCreatedAt, search, type FacetKey, type SearchQuery, type SearchRow, type SearchSort } from './services/search';
export { listExclusionLists, listExclusionRules, setExclusionList, setExclusionRule, type ExclusionRuleView } from './services/settings';
export { filterVisibleAccountIds, visibleAccounts } from './services/visibility';
export { setPractices } from './services/practices';
export { stageCountsBySource, type SourceGroup } from './services/source-stats';
export { getConflict, listConflicts, resolveConflict, type ConflictFactView, type ConflictView } from './services/conflicts';
export { addNote, listNotes, MAX_NOTE, type NoteView } from './services/notes';
export { upsertFromArrival, type UpsertResult } from './services/upsert';
export type {
  AccountView,
  ArrivalForAccounts,
  FactView,
  PersonView,
  SignalView,
  SourceChain,
} from './contracts/types';
