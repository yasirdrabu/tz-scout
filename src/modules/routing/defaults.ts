import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import { upsertSchedule } from '@/platform/scheduler';
import { autoAcceptJob } from './contracts/jobs';
import { declineReasonDef, reviewStatusDef, routingSetting } from './db/schema';

/** The review statuses every tenant starts with, in the mockup's words (REV-E1, Decision 2, Open question 1). */
export const DEFAULT_STATUSES = [
  {
    key: 'unvetted',
    label: 'Ready for review',
    order: 1,
    countsAsReviewed: false,
    isDeclined: false,
    isInitial: true,
    returnsToSource: false,
    color: 'plum',
    setBy: 'scout',
    flagAfterHours: 48,
    description: 'New from a source. Nobody has looked at it yet.',
  },
  {
    key: 'needs_review',
    label: 'In review',
    order: 2,
    countsAsReviewed: false,
    isDeclined: false,
    isInitial: false,
    returnsToSource: false,
    color: 'amber',
    setBy: 'reviewer',
    flagAfterHours: 24,
    description: 'Someone is looking at it before it goes to a seller.',
  },
  {
    key: 'reviewed',
    label: 'Approved',
    order: 3,
    countsAsReviewed: true,
    isDeclined: false,
    isInitial: false,
    returnsToSource: false,
    color: 'green',
    setBy: 'reviewer',
    flagAfterHours: null,
    description: 'Approved and ready for a seller.',
  },
  {
    key: 'declined',
    label: 'Not pursued',
    order: 4,
    countsAsReviewed: true,
    isDeclined: true,
    isInitial: false,
    returnsToSource: false,
    color: 'red',
    setBy: 'reviewer',
    flagAfterHours: null,
    description: 'We decided not to go after it, with a reason.',
  },
  {
    key: 'sent_back',
    label: 'Sent back to source',
    order: 5,
    countsAsReviewed: true,
    isDeclined: false,
    isInitial: false,
    returnsToSource: true,
    color: 'gray',
    setBy: 'reviewer',
    flagAfterHours: null,
    description: 'Returned to the source with a reason, to fix and send again.',
  },
] as const;

/**
 * Reasons. `both` is in the review and the seller decline lists; `send_back` is its own list (Decision 1).
 * "Other" needs a note.
 */
export const DEFAULT_REASONS = [
  { key: 'not_a_fit', label: 'Not a fit', appliesTo: 'both', noteRequired: false, order: 1 },
  { key: 'already_a_customer', label: 'Already a customer', appliesTo: 'review', noteRequired: false, order: 2 },
  { key: 'open_deal_elsewhere', label: 'Open deal elsewhere', appliesTo: 'review', noteRequired: false, order: 3 },
  { key: 'duplicate', label: 'Duplicate', appliesTo: 'review', noteRequired: false, order: 4 },
  { key: 'bad_data', label: 'Bad data', appliesTo: 'review', noteRequired: false, order: 5 },
  { key: 'wrong_timing', label: 'Wrong timing', appliesTo: 'review', noteRequired: false, order: 6 },
  { key: 'not_my_territory', label: 'Not my territory', appliesTo: 'assignment', noteRequired: false, order: 7 },
  { key: 'too_much_on_my_plate', label: 'Too much on my plate', appliesTo: 'assignment', noteRequired: false, order: 8 },
  { key: 'already_talking_to_them', label: 'Already talking to them', appliesTo: 'assignment', noteRequired: false, order: 9 },
  { key: 'other', label: 'Other', appliesTo: 'both', noteRequired: true, order: 10 },
  { key: 'not_our_kind_of_customer', label: 'Not our kind of customer', appliesTo: 'send_back', noteRequired: false, order: 11 },
  { key: 'existing_customer', label: 'Already a customer', appliesTo: 'send_back', noteRequired: false, order: 12 },
  { key: 'duplicate_account', label: 'Duplicate of another account', appliesTo: 'send_back', noteRequired: false, order: 13 },
  { key: 'bad_contact', label: 'Bad or missing contact', appliesTo: 'send_back', noteRequired: false, order: 14 },
  { key: 'wrong_practice', label: 'Wrong practice', appliesTo: 'send_back', noteRequired: false, order: 15 },
] as const;

export const DEFAULT_AUTO_ACCEPT_WORKING_DAYS = 2;

/** Adds what is missing and leaves changed rows alone, so it is safe to run again. */
export async function seedRoutingDefaults(ctx: ModuleContext): Promise<void> {
  const tenantId = ctx.tenantId;
  await ctx.tx
    .insert(reviewStatusDef)
    .values(DEFAULT_STATUSES.map((s) => ({ id: newId('rsd'), tenantId, ...s })))
    .onConflictDoNothing();
  await ctx.tx
    .insert(declineReasonDef)
    .values(DEFAULT_REASONS.map((r) => ({ id: newId('drd'), tenantId, ...r })))
    .onConflictDoNothing();
  await ctx.tx.insert(routingSetting).values({ tenantId, autoAcceptWorkingDays: DEFAULT_AUTO_ACCEPT_WORKING_DAYS }).onConflictDoNothing();
  // Auto-acceptance is checked every hour, on the hour.
  await upsertSchedule(
    { actor: ctx.actor, correlationId: ctx.correlationId },
    { tenantId, jobName: autoAcceptJob.name, cron: '0 * * * *', timezone: 'UTC', payload: {} },
  );
}
