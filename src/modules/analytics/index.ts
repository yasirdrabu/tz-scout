// Public interface of the analytics module. Other modules import only this file or `contracts/*`.
export {
  analyticsConsumers,
  analyticsJourneyArrival,
  analyticsJourneyDeal,
  analyticsJourneyMerge,
  analyticsJourneyScore,
  analyticsJourneyStage,
  analyticsUsageLines,
} from './consumers';
export { budgetLevelChanged } from './contracts/events';
export { backfillJourneys, loadJourneys, mergeJourneys, recordArrival, recordDeal, recordScore, recordStage, type Journey } from './services/journeys';
export type { BudgetLevel } from './domain/budgets';
export { costsBySource, getTarget, setTarget, type CostBySourceRow } from './services/costs-by-source';
export { PAST_MONTH, getBudgets, recomputeLevel, saveBudgets, summary, type BudgetsView, type CostsSummary } from './services/budgets';
export {
  AMOUNT_ABOVE_ZERO,
  MAX_NOTE,
  ONLY_MANUAL,
  VOID_REASON_NEEDED,
  addManualLine,
  afterLinesChanged,
  editManualLine,
  listLines,
  recordLine,
  voidLine,
  type CostLineView,
  type LinesQuery,
  type ManualLineInput,
  type UsageLineInput,
} from './services/lines';
export { overview, type OverviewView } from './services/overview';
export { parseTab, scorecard, sellerOf, type ScorecardTab, type ScorecardView } from './services/scorecard';
export {
  CHOOSE_PERIOD,
  funnel,
  parsePeriod,
  sourcePerformance,
  sourceStatsFromJourneys,
  type FunnelFilters,
  type FunnelRow,
  type FunnelView,
  type SourcePerformance,
  type SourceStat,
} from './services/funnel';
