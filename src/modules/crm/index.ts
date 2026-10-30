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
export { crmAccountCreated, crmAccountUpdated, crmConsumers, crmTenantDefaults } from './consumers';
export { companyCheckHandler, crmJobHandlers, ownersSyncHandler } from './jobs';
export { companyLink, getLinks, linkExternalIds, recordLink, type AccountLinks, type LinkRow, type RecordLink } from './services/links';
export { CHECK_TTL_MS, checkCompany, companyChecks, lookupCompany, queueCompanyCheck, type CompanyCheck } from './services/checks';
export {
  OWNERS_UNREADABLE,
  confirmOwnerMatch,
  isOwnerActive,
  listOwners,
  ownerMatches,
  ownerName,
  syncOwners,
  type OwnerMatch,
  type OwnerRow,
} from './services/owners';
export { CRM_SCHEDULES, DEFAULT_FIELD_MAPPINGS, seedCrmDefaults } from './defaults';
export { noteFingerprint } from './domain/fingerprint';
export { hubspotMock } from './adapters/hubspot/mock';
export { registerHubspotAdapter } from './adapters/hubspot/register';
export { seedMockCrm } from './fixtures';
