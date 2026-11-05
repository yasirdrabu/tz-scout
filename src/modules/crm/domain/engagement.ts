/** What engagement reads of a stored `crm.activity` row. Rows stored before R2d have no contacts, subject, times or status. */
export type EngagementActivity = {
  externalId: string;
  kind: string;
  occurredAt: Date;
  contacts: { externalId: string; name: string | null }[];
  subject: string | null;
  startAt: Date | null;
  endAt: Date | null;
  status: string | null;
};

export type EngagementState = 'met' | 'replied' | 'emailed' | 'not_contacted';
export type PersonEngagement = { personId: string; state: EngagementState; at: string | null };

/** When a meeting starts: its start, else when the CRM logged it (HubSpot logs a meeting at its start). */
const startOf = (a: EngagementActivity) => a.startAt ?? a.occurredAt;

/** R2d Ruling 2: status held, or scheduled (a stored meeting with no status counts as scheduled) with its end, else start, before now. */
export function meetingHeld(a: EngagementActivity, now: Date): boolean {
  if (a.kind !== 'meeting') return false;
  if (a.status === 'held') return true;
  return (a.status === 'scheduled' || a.status === null) && (a.endAt ?? startOf(a)).getTime() < now.getTime();
}

/**
 * R2d Ruling 1: the earliest meeting that starts after now and is not cancelled or a no-show. `with` is its title, else
 * the first attendee's name plus " +{n}" for the others; null when none is coming up.
 */
export function nextMeeting(rows: EngagementActivity[], now: Date): { at: string; with: string } | null {
  const next = rows
    .filter((a) => a.kind === 'meeting' && a.status !== 'cancelled' && a.status !== 'no_show' && startOf(a).getTime() > now.getTime())
    .sort((x, y) => startOf(x).getTime() - startOf(y).getTime() || x.externalId.localeCompare(y.externalId))[0];
  if (!next) return null;
  const [first, ...others] = next.contacts;
  const who = next.subject || `${first?.name ?? 'Someone'}${others.length ? ` +${others.length}` : ''}`;
  return { at: startOf(next).toISOString(), with: who };
}

/**
 * R2d Ruling 6: each person's state from the given activity (since the latest completed handoff). Met is the latest held
 * meeting listing one of their contacts, then the latest reply from one, then an email or call listing one; a person
 * with no contact link is not contacted. Kept in `contactsByPerson` order.
 */
export function personStates(rows: EngagementActivity[], contactsByPerson: Map<string, string[]>, now: Date): PersonEngagement[] {
  return [...contactsByPerson].map(([personId, contactIds]) => {
    const theirs = rows.filter((a) => a.contacts.some((c) => contactIds.includes(c.externalId)));
    const latest = (picked: EngagementActivity[], at: (a: EngagementActivity) => Date) =>
      picked.length ? new Date(Math.max(...picked.map((a) => at(a).getTime()))).toISOString() : null;
    const met = latest(theirs.filter((a) => meetingHeld(a, now)), startOf);
    if (met) return { personId, state: 'met', at: met };
    const replied = latest(theirs.filter((a) => a.kind === 'reply'), (a) => a.occurredAt);
    if (replied) return { personId, state: 'replied', at: replied };
    const emailed = latest(theirs.filter((a) => a.kind === 'email' || a.kind === 'call'), (a) => a.occurredAt);
    if (emailed) return { personId, state: 'emailed', at: emailed };
    return { personId, state: 'not_contacted', at: null };
  });
}
