// Public interface of the playbooks module. Other modules import only this file or `contracts/*`.
export { briefUpdated } from './contracts/events';
export { briefDraftJob, briefSweepJob, DRAFT_MAX_ATTEMPTS } from './contracts/jobs';
export { SWEEP_CRON, seedPlaybooksDefaults } from './defaults';
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
export { buildPackage, type PackageBrief, type PackageInput, type PackageSignal } from './domain/package';
export { followUps } from './domain/follow-ups';
