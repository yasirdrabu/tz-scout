// Public interface of the ai-tasks module. Other modules import only this file or `contracts/*`.
import { registerAnthropicAdapter } from './adapters/anthropic/mock';

registerAnthropicAdapter();

export {
  AI_LABEL,
  NO_KEY,
  defineTask,
  getRun,
  listRuns,
  runTask,
  runTotalsThisMonth,
  type AiMode,
  type AiRunRow,
  type AiStatus,
  type RunFilter,
  type RunOpts,
  type RunResult,
  type TaskDef,
} from './runner';
export type { AnthropicAdapter, CompleteRequest, CompleteResult } from './adapters/anthropic/contract';
