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
  registerOwnershipPreflight,
  type OwnershipPreflight,
  type OwnershipPreflightResult,
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
export { routingTenantDefaults } from './consumers';
export { DEFAULT_AUTO_ACCEPT_WORKING_DAYS, DEFAULT_REASONS, DEFAULT_STATUSES, seedRoutingDefaults } from './defaults';
export { nextStage, type StageEvent } from './domain/stages';
export { statusChangeProblems, type ReasonDef, type StatusDefRules } from './domain/status-rules';
export { addWorkingDays } from './domain/working-days';
export { publishReviewSnapshot } from './services/snapshot';
export { moveStage } from './services/stage';
export { routingReviewStatusValidator } from './services/status-validator';
