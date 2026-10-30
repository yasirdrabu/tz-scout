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
export { nextStage, type StageEvent } from './domain/stages';
export { declineProblems, reasonNeedsNote, statusChangeProblems, type ReasonDef, type StatusDefRules } from './domain/status-rules';
export { addWorkingDays } from './domain/working-days';
export { autoAcceptHandler } from './jobs';
export { backfillReviews } from './services/backfill';
export { publishReviewSnapshot } from './services/snapshot';
export { moveStage } from './services/stage';
export { routingReviewStatusValidator } from './services/status-validator';
export { assign, bulk, MAX_BULK, previewAssign, type AssignInput, type AssignmentView, type AssignPreview, type BulkAction, type BulkResult } from './services/assign';
export { accept, autoAccept, decline, markSeen, MAX_AUTO_ACCEPT, withdraw, type DeclineInput } from './services/respond';
export { countQueue, listQueue, type QueueFilters, type QueueRow } from './services/queue';
export { getAccountStatus, getAssignment, listAssignments, type AccountStatus, type AssignmentFilters, type AssignmentRow } from './services/read';
export { changeStatus, ensureReview, setInsights, type InsightsView, type StatusChangeInput } from './services/review';
export { getReviewSettings, setAutoAcceptWorkingDays, type ReviewSettings } from './services/settings';
