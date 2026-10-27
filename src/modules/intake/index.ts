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
} from './contracts/events';
export { importRunJob, resolveJob, waitingExpireJob } from './contracts/jobs';
export { intakeTenantDefaults } from './consumers';
export { DEFAULT_VENDOR_SOURCES, RELATIONSHIP_DEFAULTS, seedIntakeDefaults } from './defaults';
export { checkArrivalCap, type CapCheck } from './services/caps';
export {
  SOURCE_KINDS,
  childSources,
  intakeSourceAccess,
  intakeSourceInfo,
  intakeSourceValidator,
  listSources,
  personSourceFor,
  registerSource,
  updateSource,
  type RegisterSourceInput,
  type SourceKind,
  type SourceListRow,
  type SourcePatch,
  type SourceStatus,
  type SourceView,
} from './services/sources';
export {
  isStrictChannel,
  submitArrival,
  submitBatch,
  type BatchItemResult,
  type Channel,
  type SubmitOptions,
  type SubmitResult,
} from './services/submit';
