// Public interface of the playbooks module. Other modules import only this file or `contracts/*`.
export { briefUpdated, outcomeRecorded, planChanged, planCreated, planNoReply, planNotStarted, stepCompleted } from './contracts/events';
export { briefDraftJob, briefSweepJob, DRAFT_MAX_ATTEMPTS } from './contracts/jobs';
export { SWEEP_CRON, seedPlaybooksDefaults } from './defaults';
export { listStepFacts } from './services/facts';
export { sweepBriefs } from './services/sweep';
export { BRIEF_KEYS, PAGE_SECTIONS, SECTION_MAX, type BriefKey, type BriefMode, type BriefOrigin, type DraftState, type PageSectionKey } from './contracts/types';
export {
  briefFreeze,
  briefOnFact,
  briefOnMerged,
  briefOnPersonAdded,
  briefOnPersonUpdated,
  briefOnReviewChanged,
  briefOnScored,
  briefOnSignal,
  briefUnfreezeOnDeclined,
  briefUnfreezeOnWithdrawn,
  outcomesOnDealChanged,
  planOnAccepted,
  planOnMerged,
  planPauseOnWithdrawn,
  playbooksConsumers,
  playbooksTenantDefaults,
} from './consumers';
export { briefDraftHandler, briefSweepHandler, playbooksJobHandlers } from './jobs';
export { accountBriefTask } from './tasks/account-brief';
export { labelFor, writtenBy, type WrittenBy } from './domain/labels';
export { isBuyerSafe } from './domain/buyer-safe';
export { rulesBrief } from './domain/rules-brief';
export type { BriefInput, BriefOutput } from './domain/brief-io';
export { buildBriefInput, type BuiltInput } from './services/inputs';
export { requestDraft, type DraftRequest } from './services/brief';
export { runDraft, type DraftJob, type DraftMeta } from './services/draft';
export { EMPTY_SECTION, NO_SUCH_SECTION, SECTION_CHANGED, SECTION_TOO_LONG, editSection } from './services/edit';
export { getBrief, type BriefView, type SectionView } from './services/read';
export { backfillBriefs } from './services/backfill';
export { handoffPackage, playbooksHandoffPackage } from './services/package';
export { bestOfferNames } from './services/best-offer';
export { buildPackage, type PackageBrief, type PackageInput, type PackageSignal } from './domain/package';
export { followUps } from './domain/follow-ups';
export {
  HAS_RUN,
  NEEDS_NAME,
  NEEDS_STEP,
  OWNER_ROLES,
  STEP_CHANNELS,
  STOP_RULES,
  TEMPLATE_STATUSES,
  archiveTemplate,
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
  type StepInput,
  type StepView,
  type Template,
  type TemplateDetail,
  type TemplateInput,
  type TemplatePatch,
  type TemplateStatus,
  type TemplateSummary,
} from './services/templates';
export { MAPPED_TIERS, NOT_AVAILABLE, offerPlaybooks, pendingPlaybookNames, playbookFor, setOfferPlaybook, type MappedTier, type OfferPlaybookView, type PendingChoice } from './services/offer-playbooks';
export {
  FINISH_STEPS,
  MAX_NOTE,
  NEEDS_REASON,
  PLAN_ENDED,
  STEP_STATUSES,
  abandonPlan,
  completePlan,
  getPlan,
  myStepCounts,
  nextSteps,
  pausePlan,
  resumePlan,
  stopPlan,
  addStep,
  removeStep,
  updateStep,
  type HistoryView,
  type NextStep,
  type PlanSummary,
  type PlanView,
  type StepAdd,
  type StepPatch,
  type StepStatus,
  type StepView as PlanStepView,
} from './services/plans';
export { pauseOnWithdrawn, plansOnMerge, startPlan } from './services/start';
export { recordDealOutcomes, type DealOutcomeInput } from './services/deal-outcomes';
export { OUTCOME_KINDS, recordOutcome, type OutcomeInput, type OutcomeKind } from './services/outcomes';
