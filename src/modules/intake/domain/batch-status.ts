// The batch status, issue line and item outcome the app shows (Rulings 8 and 9). The API owns these words (C6, C8).

export type BatchStatusKey = 'complete' | 'in_progress' | 'needs_attention' | 'failed';
export const BATCH_STATUS_KEYS: BatchStatusKey[] = ['complete', 'in_progress', 'needs_attention', 'failed'];
export const BATCH_STATUS_LABELS: Record<BatchStatusKey, string> = {
  complete: 'Complete',
  in_progress: 'In progress',
  needs_attention: 'Needs attention',
  failed: 'Failed',
};

export type Stages = { received: number; resolving: number; waiting: number; resolved: number; rejected: number };

export type BatchStatusInput = {
  /** The stored status: `processing` or `completed`. */
  stored: string;
  importStatus: string | null;
  importError: string | null;
  /** Rows still being resolved, not counting the waiting ones. */
  received: number;
  resolving: number;
  /** Rows waiting for a person. */
  waiting: number;
  /** Rows rejected for the daily limit, not yet retried. */
  capRejected: number;
  retryable: number;
};

const rows = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Failed when the import stopped; in progress while the import is queued or rows are still resolving (the
 * stored status stays `processing` while rows wait for a person, so waiting alone is not in progress); needs
 * attention when rows wait or a rejection can be retried; complete otherwise.
 */
export function batchStatus(b: BatchStatusInput): { key: BatchStatusKey; label: string; issue: string | null } {
  const out = (key: BatchStatusKey, issue: string | null = null) => ({ key, label: BATCH_STATUS_LABELS[key], issue });
  if (b.importStatus === 'failed') {
    const error = b.importError ?? 'Something went wrong';
    return out('failed', error.startsWith('Import stopped: ') ? error : `Import stopped: ${error}`);
  }
  const resolvingNow = b.received + b.resolving > 0;
  const onlyWaiting = b.waiting > 0 && !resolvingNow;
  if (b.importStatus === 'queued' || b.importStatus === 'needs_confirm' || b.importStatus === 'uploaded' || resolvingNow) return out('in_progress');
  if (b.stored === 'processing' && !onlyWaiting) return out('in_progress');
  if (b.waiting > 0) return out('needs_attention', `${rows(b.waiting, 'row needs', 'rows need')} a website, a company or a duplicate check`);
  if (b.retryable > 0 && b.capRejected > 0) return out('needs_attention', `${rows(b.capRejected, 'row', 'rows')} hit the daily limit`);
  if (b.retryable > 0) return out('needs_attention');
  return out('complete');
}

export const progressLabel = (s: Stages): string => `${s.resolved} resolved, ${s.rejected} rejected, ${s.waiting} waiting`;

export type ItemOutcome = 'new_account' | 'matched' | 'rejected' | 'waiting' | 'resolving';

const REJECTED: Record<string, string> = {
  duplicate_in_batch: 'Rejected: Duplicate of another row in this batch',
  invalid: 'Rejected: Invalid row',
  excluded: 'Rejected: Excluded',
  daily_cap_reached: 'Rejected: Daily limit reached',
};
const WAITING: Record<string, string> = {
  needs_website: 'Waiting: Needs a website',
  needs_company: 'Waiting: Needs a company',
  possible_duplicate: 'Waiting: Possible duplicate',
};
/** The words for a rejection reason in the error report. */
export const REJECT_REASON_LABELS: Record<string, string> = {
  duplicate_in_batch: 'Duplicate of another row in this batch',
  invalid: 'Invalid row',
  excluded: 'Excluded',
  daily_cap_reached: 'Daily limit reached',
};

/** One row's outcome and its words. `accountName` is null when the caller may not see the account. */
export function itemOutcome(r: {
  status: string;
  resolution: string | null;
  reason: string | null;
  waitingOn: string | null;
  accountName: string | null;
}): { outcome: ItemOutcome; label: string } {
  if (r.status === 'resolved') {
    return r.resolution === 'attached'
      ? { outcome: 'matched', label: `Resolved: Matched ${r.accountName ?? 'an existing account'}` }
      : { outcome: 'new_account', label: 'Resolved: New account' };
  }
  if (r.status === 'rejected') return { outcome: 'rejected', label: REJECTED[r.reason ?? ''] ?? 'Rejected: Invalid row' };
  if (r.status === 'resolving' && r.waitingOn) return { outcome: 'waiting', label: WAITING[r.waitingOn] ?? 'Waiting' };
  return { outcome: 'resolving', label: 'Resolving' };
}
