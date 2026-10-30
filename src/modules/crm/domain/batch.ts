import type { HandoffStatus } from '../contracts/types';

/** "Oct 29" in the tenant timezone. */
export function shortDay(at: Date, timezone: string): string {
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: timezone });
}

/** "<Mon D> · <n> to <first name>, <n> to <first name>"; one account reads "<Mon D> · <account> to <first name>". Carried from v1. */
export function batchName(members: { name: string; seller: string }[], at: Date, timezone: string): string {
  const day = shortDay(at, timezone);
  if (members.length === 1) return `${day} · ${members[0]!.name} to ${members[0]!.seller.split(' ')[0]}`;
  const by = [...members.reduce((m, x) => m.set(x.seller, (m.get(x.seller) ?? 0) + 1), new Map<string, number>())];
  return `${day} · ${by.map(([s, n]) => `${n} to ${s.split(' ')[0]}`).join(', ')}`;
}

/** Handoffs that did not go out, listed under the message as "Not sent yet" with the reason. */
export const NOT_SENT_STATUSES: readonly HandoffStatus[] = ['failed', 'needs_decision', 'cancelled'];

const DECISION_REASONS: Record<string, string> = {
  open_deal: 'The company has an open deal with another owner. Choose whether to push anyway and keep their owner.',
  customer: 'The company is a customer with another owner. Choose whether to push anyway and keep their owner.',
  owned_elsewhere: 'The company is owned by someone else. Choose whether to push anyway and keep their owner.',
};

export function notSentReason(h: { status: string; lastError: string | null; decisionReason: string | null }): string {
  if (h.status === 'failed') return h.lastError ?? 'The push failed.';
  if (h.status === 'needs_decision') return (h.decisionReason && DECISION_REASONS[h.decisionReason]) || h.decisionReason || 'The push needs a decision.';
  return 'The handoff was cancelled.';
}

export type FollowThroughCounts = { tasksDone: number; tasksTotal: number; emails: number; calls: number; meetings: number; deals: number; openDeals: number };

/** Counts since the handoff: what the CRM has now minus what the company had when it was pushed, never below 0. */
export function followThroughCounts(row: {
  baseline: Record<string, number>;
  latest: Record<string, number>;
  tasks: { status: string }[];
}): FollowThroughCounts {
  const since = (k: string) => Math.max(0, (row.latest[k] ?? 0) - (row.baseline[k] ?? 0));
  return {
    tasksDone: row.tasks.filter((t) => t.status.toUpperCase() === 'COMPLETED').length,
    tasksTotal: row.tasks.length,
    emails: since('emails'),
    calls: since('calls'),
    meetings: since('meetings'),
    deals: since('deals'),
    openDeals: row.latest.openDeals ?? 0,
  };
}
