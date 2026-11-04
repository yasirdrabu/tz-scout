import type { RequestStatus } from '../contracts/types';

// A request's moves (Ruling 7) and the words for where it is (Global Constraints). Pure and tested.

const NEXT: Record<RequestStatus, readonly RequestStatus[]> = {
  flagged: ['approved', 'declined', 'cancelled'],
  approved: ['running', 'cancelled'],
  running: ['completed', 'partial', 'failed'],
  declined: [],
  cancelled: [],
  completed: [],
  partial: [],
  failed: [],
};

export const canTransition = (from: RequestStatus, to: RequestStatus): boolean => NEXT[from].includes(to);

/** The request row fields `statusText` reads. */
export type StatusFields = {
  status: string;
  waitingReason: string | null;
  result: { found: number; message?: string } | null;
  error: { kind: string; message: string } | null;
  declineReason: string | null;
};

export function statusText(r: StatusFields): string {
  switch (r.status) {
    case 'flagged':
      return 'Waiting for approval';
    case 'approved':
      return r.waitingReason ?? 'Starting';
    case 'running':
      // A mid-run wait on a limit, else a retry's error, so a request whose job gave up does not read "Running" forever.
      return r.waitingReason ?? r.error?.message ?? 'Running';
    case 'completed':
      return !r.result?.found && r.result?.message ? r.result.message : `Found ${r.result?.found ?? 0}`;
    case 'partial':
      return `Found ${r.result?.found ?? 0}. ${r.result?.message ?? ''}`.trim();
    case 'failed':
      return r.error?.message ?? 'Something went wrong. Try again.';
    case 'declined':
      return `Declined: ${r.declineReason ?? ''}`.trim();
    case 'cancelled':
      return r.declineReason === 'expired' ? 'Expired after 14 days' : 'Cancelled';
    default:
      return r.status;
  }
}
