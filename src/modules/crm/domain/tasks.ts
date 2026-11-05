import { offsetAt, wallClock } from '@/platform/time';
import type { PlanTasks } from '../contracts/types';

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

/** The instant of DUE_HOUR in `timezone` on a calendar day (month 1-based; the day may overflow the month). */
function dueAt(year: number, month: number, day: number, timezone: string): string {
  const wall = Date.UTC(year, month - 1, day, DUE_HOUR);
  const first = wall - offsetAt(wall, timezone);
  return new Date(wall - offsetAt(first, timezone)).toISOString();
}

/** The instant of DUE_HOUR on the tenant calendar day that is `days` after the day of `at`. */
function dueOn(at: Date, days: number, timezone: string): string {
  const p = wallClock(at.getTime(), timezone);
  return dueAt(p.year, p.month, p.day + days, timezone);
}

/** A plan step's due instant (R2c-3b Ruling 5): DUE_HOUR in the tenant timezone on its `YYYY-MM-DD` due date. */
export function dueAtOn(date: string, timezone: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return dueAt(year, month, day, timezone);
}

/**
 * A fixed handoff task the plan sync has dealt with (closed, or found done or gone): a `crm.link` keyed by assignment,
 * so it is read once. Its fingerprint is CLOSED_BY_SCOUT when Scout closed it, so the poll never reports it done.
 */
export const REPLACED_TASK = 'replaced_task';
export const CLOSED_BY_SCOUT = 'closed_by_scout';

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

/**
 * A plan step's task text (R2c-3b Ruling 4): subject `{title} ({account})`; body blocks, blank-line separated: an email
 * step's draft (the seller sends it), the step detail, then where it comes from.
 */
export function planTaskSpec(i: { step: PlanTasks['steps'][number]; accountName: string; playbookName: string; scoutUrl: string }): { subject: string; body: string } {
  const { step } = i;
  const blocks: string[] = [];
  if (step.channel === 'email' && (step.subject || step.body)) {
    blocks.push('Draft email (send it yourself)');
    if (step.subject) blocks.push(`Subject: ${step.subject}`);
    if (step.body) blocks.push(step.body);
  }
  if (step.detail) blocks.push(step.detail);
  blocks.push(`From the ${i.playbookName} playbook in Scout: ${i.scoutUrl}`);
  return { subject: `${step.title} (${i.accountName})`, body: blocks.join('\n\n') };
}
