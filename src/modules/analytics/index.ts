// Public interface of the analytics module. Other modules import only this file or `contracts/*`.
export { analyticsConsumers, analyticsUsageLines } from './consumers';
export { budgetLevelChanged } from './contracts/events';
export type { BudgetLevel } from './domain/budgets';
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
