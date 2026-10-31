import type { AiStatus } from '../runner';

/** How a finished run reads on screen (Decision 24): runs are written when they finish, so nothing is running. */
export const RUN_STATUSES = ['succeeded', 'failed', 'stopped_by_limit'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

const RAW: Record<RunStatus, AiStatus[]> = {
  succeeded: ['ok'],
  failed: ['invalid_output', 'error'],
  stopped_by_limit: ['refused_by_cap'],
};

/** The screen status for a stored `ai_run.status`. An unknown value counts as failed. */
export function runStatus(raw: string): RunStatus {
  return raw === 'ok' ? 'succeeded' : raw === 'refused_by_cap' ? 'stopped_by_limit' : 'failed';
}

/** The stored statuses a screen status covers. */
export const rawStatuses = (s: RunStatus): AiStatus[] => RAW[s];
