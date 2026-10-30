// Public interface of the CRM module. Other modules import only this file or `contracts/*`.
export {
  activityObserved,
  companyChecked,
  dealChanged,
  handoffCancelled,
  handoffCompleted,
  handoffFailed,
  handoffNeedsDecision,
  leadQualified,
} from './contracts/events';
export {
  activityPollJob,
  companyCheckJob,
  dealsPollJob,
  handoffPushJob,
  handoffUndoJob,
  ownersSyncJob,
  personPushJob,
  syncJob,
} from './contracts/jobs';
export { handoffPackageProvider, registerHandoffPackageProvider, type HandoffPackageProvider } from './contracts/ports';
export {
  CRM_SYSTEMS,
  DEFAULT_FOLLOW_UP_DAYS,
  HANDOFF_STATUSES,
  type ActivityKind,
  type CompanyLifecycle,
  type CrmSystem,
  type DealStatus,
  type HandoffPackage,
  type HandoffStatus,
  type OwnershipAction,
} from './contracts/types';
export { capabilitiesSchema, crmOperations, type CrmAdapter, type CrmCapabilities, type CrmDeal, type QualifiedLead } from './contracts/adapter';
export { crmConsumers, crmTenantDefaults } from './consumers';
export { CRM_SCHEDULES, DEFAULT_FIELD_MAPPINGS, seedCrmDefaults } from './defaults';
export { noteFingerprint } from './domain/fingerprint';
export { hubspotMock } from './adapters/hubspot/mock';
export { registerHubspotAdapter } from './adapters/hubspot/register';
export { seedMockCrm } from './fixtures';
