// The account page's HubSpot activity feed (screens.md §4b item 3): CRM activity and Scout's own actions, as one-liners. Pure.
import type { HandoffUndone } from '../contracts/types';

export type ActivityEntry = { id: string; kind: string; at: Date; summary: string };

const SUMMARY: Record<string, string> = {
  email: 'Email sent',
  reply: 'Reply received',
  call: 'Call logged',
  meeting: 'Meeting held',
  task_done: 'Task done',
};

export const activityEntry = (a: { id: string; kind: string; occurredAt: Date }): ActivityEntry => ({
  id: a.id,
  kind: a.kind,
  at: a.occurredAt,
  summary: SUMMARY[a.kind] ?? 'Activity logged',
});

const and = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? ''));
const noStop = (s: string) => s.trim().replace(/[.!?]+$/, '');
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** What an undo did, as the end of "Scout took the account back: {reason}." */
export function undoReason(u: HandoffUndone, returnedToName: string | null): string {
  if (u.failed) return noStop(u.reason ?? 'the undo stopped before it finished');
  const parts: string[] = [];
  const n = u.tasksClosed.length;
  if (n > 0) parts.push(`closed ${n} task${n === 1 ? '' : 's'}`);
  if (u.ownerReturnedTo) parts.push(`gave the company back to ${returnedToName ?? 'its previous owner'}`);
  if (u.ownerNote) parts.push(lowerFirst(noStop(u.ownerNote)));
  return parts.length ? and(parts) : 'nothing else had to change in HubSpot';
}

export type ScoutHandoff = {
  id: string;
  status: string;
  ownershipAction: string;
  completedAt: Date | null;
  undone: HandoffUndone | null;
};

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * "Scout took the account back: …" (Ruling 18). With a cause it says who declined it and why, or who withdrew it,
 * then what the undo did; an undo stored before causes were kept says only what it did.
 */
export function undoSummary(u: HandoffUndone, returnedToName: string | null): string {
  const did = undoReason(u, returnedToName);
  const c = u.cause;
  if (!c) return `Scout took the account back: ${did}.`;
  const who =
    c.kind === 'declined'
      ? `${c.byName ?? 'the seller'} declined it${c.reasonLabel ? ` (${noStop(c.reasonLabel)})` : ''}`
      : `${c.byName ?? 'the assigner'} withdrew the assignment`;
  return `Scout took the account back: ${who}. ${upperFirst(did)}.`;
}

/** Scout's rows for one handoff: the push once it completed, and the undo once it ran. */
export function scoutEntries(h: ScoutHandoff, names: { seller: string | null; owner: string | null; returnedTo: string | null }): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  if (h.status === 'completed' && h.completedAt) {
    out.push({
      id: `${h.id}:sent`,
      kind: 'scout',
      at: h.completedAt,
      summary:
        h.ownershipAction === 'assign'
          ? `Scout sent the account to HubSpot with ${names.seller ?? 'the seller'} as owner and logged the brief.`
          : `Scout sent the account to HubSpot and left ${names.owner ?? 'the current owner'} as owner.`,
    });
  }
  if (h.undone) {
    out.push({ id: `${h.id}:undone`, kind: 'scout', at: new Date(h.undone.at), summary: undoSummary(h.undone, names.returnedTo) });
  }
  return out;
}

export const newestFirst = (a: ActivityEntry, b: ActivityEntry) => b.at.getTime() - a.at.getTime() || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);

/** A filter for the rows after the cursor in newest-first order. */
export function afterCursor(cursor: { at: string; id: string } | null): (e: ActivityEntry) => boolean {
  if (!cursor) return () => true;
  const t = new Date(cursor.at).getTime();
  return (e) => e.at.getTime() < t || (e.at.getTime() === t && e.id < cursor.id);
}
