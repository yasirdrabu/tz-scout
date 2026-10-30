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
  PUSH_MAX_ATTEMPTS,
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
export {
  crmAccountCreated,
  crmAccountMerged,
  crmAccountUpdated,
  crmAssignmentCreated,
  crmAssignmentDeclined,
  crmAssignmentWithdrawn,
  crmConsumers,
  crmPersonAdded,
  crmTenantDefaults,
} from './consumers';
export { activityPollHandler, companyCheckHandler, dealsPollHandler, crmJobHandlers, syncHandler, handoffPushHandler, handoffUndoHandler, ownersSyncHandler, personPushHandler } from './jobs';
export { ASSIGN_FIRST, push, queuePersonPush, runPersonPush } from './services/push';
export { POLL_LIMIT, POLL_WINDOW_MS, checkFollowThrough, followThrough, pollActivity, syncAccount } from './services/follow-through';
export { getHandoffs, lastActivityAt, latestHandoff, type HandoffRow, type HandoffsView } from './services/read';
export {
  DEFAULT_QUALIFIED_LEAD_RULE,
  getCrmSettings,
  setCrmSettings,
  setUpHubSpotFields,
  type CrmSettings,
  type CrmSettingsPatch,
  type QualifiedLeadRule,
} from './services/settings';
export { MAX_ATTEMPTS, queueHandoff, runPush } from './services/handoff';
export { crmMergeGuard } from './services/merge';
export { requestUndo, runUndo, type UndoReason } from './services/undo';
export { batchFor, getBatch, listBatches, markCopied, refreshBatch, type BatchView } from './services/batches';
export { batchName } from './domain/batch';
export { countsOfRow, followThroughCounts, type FollowThroughCounts, type LatestState } from './domain/follow-through';
export { handoffMessage, handoffMessages, replyBy, type HandoffAccount, type HandoffMessage } from './domain/message';
export { NO_CRM_OWNER, OWNER_INACTIVE, RETRIES_FAILED, SOMETHING_WRONG, TOKEN_REFUSED, UNREADABLE_ANSWER, classifyPushError } from './domain/push-errors';
export { companyLink, getLinks, linkExternalIds, recordLink, type AccountLinks, type LinkRow, type RecordLink } from './services/links';
export { CHECK_TTL_MS, checkCompany, companyChecks, lookupCompany, queueCompanyCheck, refreshCheck, type CompanyCheck } from './services/checks';
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
export { decideOwnership, type OwnershipDecision, type OwnershipInput } from './domain/ownership';
export { crmOwnershipPreflight, preflightOwnership, type OwnershipPreflightDetail } from './services/preflight';
export { noteFingerprint } from './domain/fingerprint';
export { hubspotMock } from './adapters/hubspot/mock';
export { registerHubspotAdapter } from './adapters/hubspot/register';
export { seedMockCrm } from './fixtures';
export { DEALS_FIRST_LOOKBACK_MS, DEALS_OVERLAP_MS, applyDeals, companyLifecycle, pollDeals } from './services/deals';
export { handleCrmWebhook } from './services/webhook';
export { SIGNATURE_MAX_AGE_MS, parseHubSpotWebhook, verifyHubSpotV3, type SignedRequest, type WebhookEvent } from './domain/webhook';
