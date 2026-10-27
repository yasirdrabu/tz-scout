import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import { upsertSchedule } from '@/platform/scheduler';
import { autoAcceptJob } from './contracts/jobs';
import { declineReasonDef, reviewStatusDef, routingSetting } from './db/schema';

/** The review statuses every tenant starts with (REV-E1). */
export const DEFAULT_STATUSES = [
  { key: 'unvetted', label: 'Unvetted', order: 1, countsAsReviewed: false, isDeclined: false, isInitial: true, tone: 'neutral' },
  { key: 'needs_review', label: 'Needs review', order: 2, countsAsReviewed: false, isDeclined: false, isInitial: false, tone: 'near' },
  { key: 'reviewed', label: 'Reviewed', order: 3, countsAsReviewed: true, isDeclined: false, isInitial: false, tone: 'good' },
  { key: 'declined', label: 'Declined', order: 4, countsAsReviewed: true, isDeclined: true, isInitial: false, tone: 'bad' },
] as const;

/** Decline reasons. "Not a fit" and "Other" (note required) are in both lists, so they apply to both. */
export const DEFAULT_REASONS = [
  { key: 'not_a_fit', label: 'Not a fit', appliesTo: 'both' },
  { key: 'already_a_customer', label: 'Already a customer', appliesTo: 'review' },
  { key: 'open_deal_elsewhere', label: 'Open deal elsewhere', appliesTo: 'review' },
  { key: 'duplicate', label: 'Duplicate', appliesTo: 'review' },
  { key: 'bad_data', label: 'Bad data', appliesTo: 'review' },
  { key: 'wrong_timing', label: 'Wrong timing', appliesTo: 'review' },
  { key: 'not_my_territory', label: 'Not my territory', appliesTo: 'assignment' },
  { key: 'too_much_on_my_plate', label: 'Too much on my plate', appliesTo: 'assignment' },
  { key: 'already_talking_to_them', label: 'Already talking to them', appliesTo: 'assignment' },
  { key: 'other', label: 'Other', appliesTo: 'both' },
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
