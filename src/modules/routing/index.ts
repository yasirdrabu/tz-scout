// Public interface of the routing module. Other modules import only this file or `contracts/*`.
export {
  assignmentAccepted,
  assignmentCreated,
  assignmentDeclined,
  assignmentWithdrawn,
  reviewChanged,
  stageChanged,
  statusChanged,
} from './contracts/events';
export { autoAcceptJob } from './contracts/jobs';
export {
  ownershipPreflight,
  PREFLIGHT_RESULTS,
  registerOwnershipPreflight,
  type OwnershipPreflight,
  type OwnershipPreflightResult,
  type PreflightResultKey,
} from './contracts/ports';
export {
  ASSIGNMENT_STATUSES,
  REVIEW_FLAGS,
  STAGES,
  type AssignmentStatus,
  type ReviewFlag,
  type ReviewFlags,
  type ReviewSnapshot,
  type Stage,
} from './contracts/types';
export { routingAccountMerged, routingArrivalResolved, routingConsumers, routingCrmActivity, routingCrmDeal, routingCrmHandoffCancelled, routingCrmHandoffCompleted, routingCrmHandoffFailed, routingCrmHandoffNeedsDecision, routingMemberRemoved, routingTenantDefaults } from './consumers';
export { DEFAULT_AUTO_ACCEPT_WORKING_DAYS, DEFAULT_REASONS, DEFAULT_STATUSES, seedRoutingDefaults } from './defaults';
export { EXIT_STAGES, nextStage, PIPELINE_STAGES, STAGE_LABELS, type StageEvent } from './domain/stages';
export { declineProblems, inList, REASON_LISTS, statusChangeProblems, type ReasonDef, type ReasonList, type StatusDefRules } from './domain/status-rules';
export { STATUS_COLORS, STATUS_SET_BY, type ReasonEdit, type StatusEdit } from './domain/review-settings';
export { addWorkingDays } from './domain/working-days';
export { autoAcceptHandler } from './jobs';
export { backfillLeadOffers, backfillReviews } from './services/backfill';
export { publishReviewSnapshot } from './services/snapshot';
export { moveStage } from './services/stage';
export { routingReviewStatusValidator } from './services/status-validator';
export { assign, bulk, MAX_BULK, previewAssign, previewBulkAssign, setLeadOffer, type BulkPreviewRow, type LeadOfferView, type AssignInput, type AssignmentView, type AssignPreview, type BulkAction, type BulkResult } from './services/assign';
export { accept, autoAccept, decline, markSeen, MAX_AUTO_ACCEPT, withdraw, type DeclineInput } from './services/respond';
export { countQueue, getQueueColumns, listQueue, queueFacets, resetQueueColumns, setQueueColumns, type FacetOption, type QueueFacets, type QueueFilters, type QueueRow } from './services/queue';
export { getAccountReview, listChanges, type AccountReviewView, type ChangeView } from './services/account-review';
export { accountFacets, exportAccounts, listAccounts, MAX_EXPORT_ROWS, type AccountFacets, type AccountListFilters, type AccountListRow } from './services/pipeline';
export { QUEUE_COLUMNS, type ColumnChoice, type ColumnsView } from './domain/columns';
export { assignableSellers, practicesOf, type AssignableSeller } from './services/sellers';
export { countNewAssignments, getAccountStatus, getAssignment, listAssignments, openAssignmentCounts, type AccountStatus, type AssignmentFilters, type AssignmentRow } from './services/read';
export { changeStatus, ensureReview, setInsights, type InsightsView, type StatusChangeInput } from './services/review';
export { getReviewSettings, listReasons, listStatuses, resetReviewSettings, saveReasons, saveStatuses, setAutoAcceptWorkingDays, type ReasonView, type ReviewSettings, type StatusView } from './services/settings';
