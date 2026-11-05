// The account page's HubSpot activity feed (screens.md §4b item 3): CRM activity and Scout's own actions, as one-liners. Pure.
import type { HandoffUndone } from '../contracts/types';

import { meetingHeld } from './engagement';

/** `who` is a name or null when the CRM did not say; `actor` says what kind of party did it, for the avatar. */
export type ActivityEntry = { id: string; kind: string; at: Date; who: string | null; actor: 'person' | 'contact' | 'scout'; summary: string };

/** A stored `crm.activity` row as the feed reads it. Never a body. */
export type StoredActivity = {
  id: string;
  kind: string;
  occurredAt: Date;
  contacts: { externalId: string; name: string | null }[];
  subject: string | null;
  startAt: Date | null;
  endAt: Date | null;
  status: string | null;
};

const FIXED: Record<string, string> = {
  email: 'Email sent',
  reply: 'Reply received',
  call: 'Call logged',
  meeting: 'Meeting held',
  task_done: 'Task done',
};

/** "Nov 18". */
export const monthDay = (d: Date, timeZone: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(d);

/** The named contacts as "A", "A and B", or "A, B and 2 others"; null when none has a name. */
export function namesOf(contacts: { name: string | null }[]): string | null {
  const named = contacts.map((c) => c.name).filter((n): n is string => !!n);
  if (named.length === 0) return null;
  if (named.length === 1) return named[0]!;
  if (named.length === 2) return `${named[0]} and ${named[1]}`;
  const rest = named.length - 2;
  return `${named[0]}, ${named[1]} and ${rest} other${rest === 1 ? '' : 's'}`;
}

/** Minutes between a meeting's start and end, when both are known and the end is after the start. */
const minutes = (a: StoredActivity) => (a.startAt && a.endAt && a.endAt > a.startAt ? Math.round((a.endAt.getTime() - a.startAt.getTime()) / 60_000) : 0);

function meetingSummary(a: StoredActivity, names: string | null, now: Date, timeZone: string): string {
  if (a.status === 'cancelled') return 'Meeting cancelled';
  if (a.status === 'no_show') return 'Meeting missed';
  const withWho = names ? ` with ${names}` : '';
  if (meetingHeld({ ...a, externalId: a.id }, now)) {
    const m = minutes(a);
    return `Meeting held${withWho}${m ? `, ${m} minute${m === 1 ? '' : 's'}` : ''}`;
  }
  return `Meeting booked for ${monthDay(a.startAt ?? a.occurredAt, timeZone)}${withWho}`;
}

/**
 * One CRM row as a feed entry (R2d Ruling 8). `who` is the seller's name for what they did (null when the actor is not known);
 * a reply is by the first contact. Meetings sit at their start. With nothing known the old fixed words apply.
 */
export function activityEntry(a: StoredActivity, ctx: { who: string | null; now: Date; timeZone: string }): ActivityEntry {
  const names = namesOf(a.contacts);
  const entry = { id: a.id, kind: a.kind, at: a.kind === 'meeting' ? (a.startAt ?? a.occurredAt) : a.occurredAt };
  const person = { ...entry, who: ctx.who, actor: 'person' as const };
  switch (a.kind) {
    case 'email':
      return { ...person, summary: a.subject ? `Sent "${a.subject}"${names ? ` to ${names}` : ''}` : names ? `Sent an email to ${names}` : FIXED.email! };
    case 'reply':
      return { ...entry, who: a.contacts[0]?.name ?? null, actor: 'contact', summary: a.subject ? `Replied: "${a.subject}"` : names ? 'Replied' : FIXED.reply! };
    case 'call':
      return { ...person, summary: names ? `Call with ${names}` : FIXED.call! };
    case 'meeting':
      return { ...person, summary: meetingSummary(a, names, ctx.now, ctx.timeZone) };
    default:
      return { ...person, summary: FIXED[a.kind] ?? 'Activity logged' };
  }
}

/** The row for a plan's start (R2d Ruling 9): Scout began the playbook when the plan was made. */
export const planStartEntry = (p: { planId: string; playbookName: string; startedAt: string }): ActivityEntry => ({
  id: `${p.planId}:started`,
  kind: 'scout',
  at: new Date(p.startedAt),
  who: 'Scout',
  actor: 'scout',
  summary: `Started the ${p.playbookName} playbook`,
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
      who: 'Scout',
      actor: 'scout',
      summary:
        h.ownershipAction === 'assign'
          ? `Scout sent the account to HubSpot with ${names.seller ?? 'the seller'} as owner and logged the brief.`
          : `Scout sent the account to HubSpot and left ${names.owner ?? 'the current owner'} as owner.`,
    });
  }
  if (h.undone) {
    out.push({ id: `${h.id}:undone`, kind: 'scout', at: new Date(h.undone.at), who: 'Scout', actor: 'scout', summary: undoSummary(h.undone, names.returnedTo) });
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
