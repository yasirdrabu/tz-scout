// Public interface of the enrichment module. Other modules import only this file or `contracts/*`.
export { requestApproved, requestCancelled, requestCompleted, requestDeclined, requestFailed, requestFlagged } from './contracts/events';
export { expireRequestsJob, runRequestJob } from './contracts/jobs';
export {
  ERROR_KINDS,
  KINDS,
  REQUEST_STATUSES,
  type EnrichmentErrorKind,
  type EnrichmentKind,
  type Estimate,
  type RequestStatus,
} from './contracts/types';
export { kindLabel, operationsFor } from './domain/kinds';
export { DEFAULT_CENTS_PER_CREDIT, WEBSITE_READ_WORST_CENTS } from './domain/prices';
export { estimate, estimateText, type EstimateInput } from './domain/estimate';
export { canTransition, statusText, type StatusFields } from './domain/status';
export { SOMETHING_WRONG, classifyError, type ClassifiedError } from './domain/errors';
export { EXPIRE_CRON, seedEnrichmentDefaults } from './defaults';
export {
  DECLINE_REASON_NEEDED,
  PEOPLE_ONLY,
  REASON_NEEDED,
  approveRequest,
  cancelRequest,
  createRequest,
  declineRequest,
  estimateFor,
  getRequest,
  listRequests,
  type RequestInput,
  type RequestView,
} from './services/requests';
export { EXPIRE_AFTER_DAYS, expireFlagged } from './services/expire';
export { enrichmentJobHandlers, expireRequestsHandler } from './jobs';
export {
  EMAIL_STATUSES,
  type CompanyFacts,
  type EmailStatus,
  type EnrichmentAdapter,
  type Paid,
  type Person,
  type Signal,
  type SitePage,
} from './contracts/adapter';
export { registerApolloAdapter } from './adapters/apollo/register';
export { registerVibeAdapter } from './adapters/vibe/register';
export { registerWebsiteAdapter } from './adapters/website/register';
export { setMockFailure, type MockFailureKind } from './adapters/mock-failure';
export { readWebsite, readWebsiteTask } from './tasks/read-website';
export { citedOnly, readWebsiteInput, rulesRead, type ReadWebsiteInput, type ReadWebsiteOutput } from './domain/read-website';
