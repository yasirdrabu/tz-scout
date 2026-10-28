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
} from './contracts/events';
export { normaliseDomain } from './domain/normalise';
export { importRunJob, resolveJob, waitingExpireJob } from './contracts/jobs';
export { intakeAccountMerged, intakeSellerDeclineFeedback, intakeStatusFeedback, intakeTenantDefaults } from './consumers';
export { feedbackForArrival, listFeedback, recordFeedback, type ArrivalFeedback, type FeedbackKind, type FeedbackView } from './services/feedback';
export { importRunHandler, resolveHandler, waitingExpireHandler } from './jobs';
export { DEFAULT_VENDOR_SOURCES, RELATIONSHIP_DEFAULTS, seedIntakeDefaults } from './defaults';
export { listRelationshipDefaults, setRelationshipDefault, type RelationshipDefaultView } from './services/settings';
export { checkArrivalCap, type CapCheck } from './services/caps';
export {
  SOURCE_KINDS,
  accountIdsForSource,
  bestTrustForAccounts,
  chainsForAccount,
  childSources,
  intakeSourceAccess,
  intakeSourceInfo,
  intakeSourceValidator,
  listSources,
  personSourceFor,
  registerSource,
  sourceNames,
  updateSource,
  type RegisterSourceInput,
  type SourceKind,
  type SourceListRow,
  type SourcePatch,
  type SourceStatus,
  type SourceView,
} from './services/sources';
export {
  rejectArrival,
  resolveArrival,
  type InlineResult,
  type RejectReason,
} from './services/resolve';
export type { ResolutionInput } from './domain/normalise-arrival';
export { getWarmIntro, recordWarmIntro, type DeclaredBy, type WarmIntroInput, type WarmIntroView } from './services/warm-intros';
export {
  isStrictChannel,
  submitArrival,
  submitBatch,
  type BatchItemResult,
  type Channel,
  type SubmitOptions,
  type SubmitResult,
} from './services/submit';
export {
  accountForArrival,
  batchAccountIds,
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
  confirmImport,
  createImport,
  getImport,
  previewImport,
  setImportChunkSize,
  type ImportCreated,
  type ImportView,
} from './services/imports';
export { registerReviewStatusValidator, type ReviewStatusValidator } from './contracts/ports';
