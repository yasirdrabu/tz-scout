// Public interface of the intake module. Other modules import only this file or `contracts/*`.
export {
  ArrivalV1Schema,
  BatchEnvelopeV1Schema,
  BatchV1Schema,
  moveItemFields,
  type ArrivalV1,
  type BatchV1,
} from './contracts/arrival';
export {
  arrivalReceived,
  arrivalRejected,
  arrivalResolved,
  arrivalWaiting,
  batchCompleted,
  batchCreated,
  feedbackRecorded,
  sourceTrustChanged,
  warmIntroConfirmed,
  warmIntroRepriced,
} from './contracts/events';
export { countryCode, normaliseDomain } from './domain/normalise';
export { importRunJob, qualifiedLeadsPollJob, resolveJob, waitingExpireJob } from './contracts/jobs';
export { intakeAccountMerged, intakeConflictFeedback, intakeLeadQualified, intakeSellerDeclineFeedback, intakeStatusFeedback, intakeTenantDefaults } from './consumers';
export { feedbackForArrival, listFeedback, recordConflictLost, recordFeedback, recordSourceFeedback, type ArrivalFeedback, type FeedbackKind, type FeedbackView } from './services/feedback';
export { importRunHandler, qualifiedLeadsPollHandler, resolveHandler, waitingExpireHandler } from './jobs';
export {
  FIRST_POLL_LOOKBACK_MS,
  LEADS_OVERLAP_MS,
  SAMPLE_LEAD_EMAIL,
  leadRef,
  pollQualifiedLeads,
  requestSync,
  simulateQualifiedLead,
  submitQualifiedLead,
  takeQualifiedLead,
  type SyncStatus,
} from './services/qualified-leads';
export { DEFAULT_VENDOR_SOURCES, RELATIONSHIP_DEFAULTS, seedIntakeDefaults } from './defaults';
export {
  getWarmIntroSettings,
  listRelationshipDefaults,
  saveWarmIntroSettings,
  type RelationshipDefaultView,
  type WarmIntroSettings,
  type WarmIntroSettingsInput,
} from './services/settings';
export { checkArrivalCap, type CapCheck } from './services/caps';
export {
  LIST_HAS_NO_KEYS,
  ONE_CRM_SOURCE,
  SOURCE_KINDS,
  hasCrmSource,
  readSource,
  removeSource,
  accountIdsForSource,
  bestTrustForAccounts,
  chainsForAccount,
  childSources,
  ensureVendorSource,
  intakeSourceAccess,
  intakeSourceInfo,
  intakeSourceValidator,
  listSources,
  personSourceFor,
  registerSource,
  renamePersonSources,
  firstSources,
  sourceNames,
  sourcesOfAccount,
  updateSource,
  type AccountSource,
  type RegisterSourceInput,
  type SourceKind,
  type SourceListFilter,
  type SourceListRow,
  type SourcePatch,
  type SourceStatus,
  type SourceView,
} from './services/sources';
export {
  KIND_LABELS,
  TRUST_LABEL,
  firstArrivals,
  newSourceDetail,
  sourceDetail,
  sourceFunnel,
  sourceStats,
  sourceViews,
  type FirstArrival,
  type SendMethod,
  type SourceApiView,
  type SourceDetail,
  type SourceFunnel,
} from './services/source-read';
export {
  rejectArrival,
  resolveArrival,
  type InlineResult,
  type RejectReason,
} from './services/resolve';
export type { ResolutionInput } from './domain/normalise-arrival';
export {
  accountIdsForWarmIntroChange,
  confirmWarmIntro,
  getWarmIntro,
  recordWarmIntro,
  type DeclaredBy,
  type WarmIntroInput,
  type WarmIntroView,
} from './services/warm-intros';
export { pickRule } from './domain/warm-intro';
export {
  isStrictChannel,
  submitArrival,
  submitBatch,
  type ArrivalExternalIds,
  type BatchItemResult,
  type Channel,
  type SubmitOptions,
  type SubmitResult,
} from './services/submit';
export {
  accountForArrival,
  batchAccountIds,
  countBatches,
  getArrival,
  getArrivalWithStatus,
  getBatch,
  initialReviewStatusKeys,
  listArrivals,
  listBatchItems,
  listBatches,
  type ArrivalDetail,
  type ArrivalFilter,
  type ArrivalWithStatus,
  type ArrivalView,
  type BatchDetail,
  type BatchView,
} from './services/status';
export { visibleArrivals, type ArrivalScope } from './services/visibility';
export { chooseDuplicate, listWaiting, skipWaiting, supplyCompany, supplyWebsite } from './services/waiting';
export {
  chooseMapping,
  deleteMapping,
  headerSignature,
  listMappings,
  saveMapping,
  type ChosenMapping,
  type MappingOrigin,
  type SavedMapping,
} from './services/mappings';
export { attachFile, listBatchFiles, readFile, type BatchFileView, type FileInput, type StoredFile } from './services/files';
export {
  CREDIT_ANOTHER_SOURCE,
  confirmImport,
  createImport,
  discardImport,
  getImport,
  previewImport,
  setImportChunkSize,
  type ImportCreated,
  type ImportView,
} from './services/imports';
export { registerFunnelStages, registerReviewStatusValidator, type FunnelStages, type ReviewStatusValidator } from './contracts/ports';
export {
  ITEM_STATUSES,
  fileIdOf,
  listBatchItemRows,
  listBatchRows,
  readBatchFile,
  readBatchRow,
  rejectionRows,
  type BatchDetailRow,
  type BatchItemView,
  type BatchListFilters,
  type BatchRowView,
  type ItemStatus,
  type RejectionRow,
} from './services/batches-read';
export { BATCH_STATUS_KEYS, BATCH_STATUS_LABELS, type BatchStatusKey } from './domain/batch-status';
export { retryBatch } from './services/retry';
// The pure Vibe Prospecting mapping, shared with the enrichment module's sample Vibe adapter (one copy of the rules).
export {
  fromVibeExportRow,
  fromVibeProspectRow,
  isParty,
  mapEvent,
  nameKey,
  seniority,
  topicLabel,
  vibeSignals,
  type VibeCompany,
  type VibeEvent,
  type VibePerson,
} from './import/layouts/vibe';
