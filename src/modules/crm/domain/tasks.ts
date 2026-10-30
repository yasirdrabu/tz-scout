import { offsetAt, wallClock } from '@/platform/time';

export type TaskSpec = { subject: string; body: string; dueAt: string };

export type TaskInput = {
  account: { name: string };
  buyer: { name: string; title: string | null; email: string | null } | null;
  offerName: string | null;
  followUpDays: readonly number[];
  handoffAt: Date;
  timezone: string;
  pkg: {
    firstTouch: { subject: string; body: string } | null;
    followUps: { day: number; subject: string; body: string }[];
  } | null;
};

/** Tasks are due at the end of the working day (17:00) in the tenant timezone. */
const DUE_HOUR = 17;

/** The instant of DUE_HOUR on the tenant calendar day that is `days` after the day of `at`. */
function dueOn(at: Date, days: number, timezone: string): string {
  const p = wallClock(at.getTime(), timezone);
  const wall = Date.UTC(p.year, p.month - 1, p.day + days, DUE_HOUR);
  const first = wall - offsetAt(wall, timezone);
  return new Date(wall - offsetAt(first, timezone)).toISOString();
}

export const NO_BUYER_SENTENCE = 'No buyer contact yet; the note lists who to look for.';

export function buildTasks(input: TaskInput): { firstTouch: TaskSpec; followUps: (TaskSpec & { day: number })[] } {
  const { account, buyer, offerName, pkg, timezone } = input;
  const who = buyer?.name ?? account.name;
  const firstDue = dueOn(input.handoffAt, 0, timezone);
  const firstTouch: TaskSpec = pkg?.firstTouch
    ? { ...pkg.firstTouch, dueAt: firstDue }
    : {
        subject: buyer ? `First touch: ${buyer.name} at ${account.name}` : `First touch: ${account.name}`,
        body: buyer
          ? `Start with ${buyer.name}${buyer.title ? `, ${buyer.title}` : ''}${buyer.email ? ` (${buyer.email})` : ''}.`
          : NO_BUYER_SENTENCE,
        dueAt: firstDue,
      };

  const n = input.followUpDays.length;
  const followUps = pkg?.followUps.length
    ? pkg.followUps.map((f) => ({ day: f.day, subject: f.subject, body: f.body, dueAt: dueOn(input.handoffAt, f.day, timezone) }))
    : input.followUpDays.map((day, i) => ({
        day,
        subject: `Follow-up ${i + 1} of ${n} (day ${day}): email ${who}`,
        body: `No follow-up email written yet. Write to ${who} about ${offerName ?? account.name}.`,
        dueAt: dueOn(input.handoffAt, day, timezone),
      }));
  return { firstTouch, followUps };
}
