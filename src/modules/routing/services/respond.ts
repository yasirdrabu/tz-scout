import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { members, tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { logFor } from '@/platform/log';
import { publish } from '@/platform/events/outbox';
import { assignmentAccepted, assignmentDeclined } from '../contracts/events';
import type { ReviewSnapshot } from '../contracts/types';
import { DEFAULT_AUTO_ACCEPT_WORKING_DAYS } from '../defaults';
import { accountReview, assignment, declineReasonDef, routingSetting } from '../db/schema';
import { addWorkingDays } from '../domain/working-days';
import { declineProblems } from '../domain/status-rules';
import { assign, type AssignmentView } from './assign';
import { checkLength, endAssignment, lockForWrite, lockRow, OPEN_STATUSES, openAssignment, requirePerson } from './review';
import { currentReviewSnapshot, publishReviewSnapshot } from './snapshot';
import { moveStage } from './stage';

/** Most assignments one auto-accept run accepts (Ruling 6). */
export const MAX_AUTO_ACCEPT = 500;

type Row = typeof accountReview.$inferSelect;
type Assignment = typeof assignment.$inferSelect;

const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That assignment was not found.' });
const conflict = (title: string) => new ScoutError({ slug: 'conflict', status: 409, title });
const answered = () => conflict('That assignment is no longer waiting for an answer.');
const reviewWhere = (ctx: ModuleContext, accountId: string) => and(eq(accountReview.tenantId, ctx.tenantId), eq(accountReview.accountId, accountId));

async function loadAssignment(ctx: ModuleContext, id: string): Promise<Assignment | null> {
  const [a] = await ctx.tx.select().from(assignment).where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.id, id)));
  return a ?? null;
}

/**
 * Locks the review row of an assignment's account and reads the assignment again under the lock, so what
 * the caller checks is what it writes. Visibility of the account is not needed (Ruling 17); when
 * `sellerUserId` is given the assignment must be that seller's, else it is a 404.
 */
async function lockAssignment(ctx: ModuleContext, id: string, sellerUserId?: string): Promise<{ a: Assignment; row: Row }> {
  const first = await loadAssignment(ctx, id);
  if (!first || (sellerUserId && first.sellerUserId !== sellerUserId)) throw notFound();
  const row = await lockRow(ctx, first.accountId);
  const a = await loadAssignment(ctx, id);
  // A merge between the two reads moves the assignment to the survivor; that is a retry, not a guess.
  if (!row || row.mergedInto || !a || a.accountId !== first.accountId) throw notFound();
  return { a, row };
}

/** Accepts a pending assignment on a locked row. The caller publishes the snapshot. */
export async function acceptLocked(ctx: ModuleContext, a: Assignment, how: 'seller' | 'auto_timeout' | 'crm_activity', at: Date): Promise<void> {
  await ctx.tx
    .update(assignment)
    .set({ status: 'accepted', acceptedHow: how, respondedAt: at })
    .where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.id, a.id)));
  await publish(ctx, assignmentAccepted, { assignmentId: a.id, accountId: a.accountId, sellerUserId: a.sellerUserId, acceptedHow: how });
  await moveStage(ctx, a.accountId, 'assigned', `${a.id}:accepted`);
}

/** The seller accepts their pending assignment (REV-E2-S2-AC1). */
export async function accept(ctx: ModuleContext, assignmentId: string): Promise<void> {
  const by = requirePerson(ctx);
  const { a } = await lockAssignment(ctx, assignmentId, by);
  if (a.status !== 'pending') throw answered();
  await acceptLocked(ctx, a, 'seller', new Date());
  await publishReviewSnapshot(ctx, a.accountId);
}

export type DeclineInput = { reasonKey: string; note?: string | null };

/**
 * The seller declines their open assignment (pending, or accepted by them or by timeout) with a reason from the assignment list; Other needs a
 * note (REV-E2-S3). The account goes back to the leader: status unchanged, stage `reviewed`, with the
 * `declinedBySeller` flag until it is assigned again (Ruling 15).
 */
export async function decline(ctx: ModuleContext, assignmentId: string, input: DeclineInput): Promise<void> {
  const by = requirePerson(ctx);
  const { a, row } = await lockAssignment(ctx, assignmentId, by);
  if (!OPEN_STATUSES.includes(a.status)) throw answered();
  const note = input.note?.trim() || null;
  checkLength(note, 'note');

  const defs = await ctx.tx.select().from(declineReasonDef).where(eq(declineReasonDef.tenantId, ctx.tenantId));
  const reasonKey = input.reasonKey?.trim() ?? '';
  const reason = defs.find((d) => d.key === reasonKey && d.appliesTo !== 'review' && !d.archivedAt);
  const problems = declineProblems(reason, note);
  if (problems.length > 0) {
    throw new ScoutError({
      slug: 'validation',
      status: 400,
      title: problems[0]!,
      errors: problems.map((message) => ({ path: message === 'Pick a reason' ? 'reason_key' : 'note', message })),
    });
  }
  const reasonLabel = reason!.label;
  const at = new Date();
  const sellerName = (await members(ctx)).find((m) => m.userId === a.sellerUserId)?.name ?? 'The seller';

  await ctx.tx
    .update(assignment)
    .set({ status: 'declined', respondedAt: at, declineReasonKey: reasonKey, declineNote: note })
    .where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.id, a.id)));
  // "New from" belongs to the assignment, so it ends with it.
  const { newFrom: _ended, ...flags } = row.flags;
  await ctx.tx
    .update(accountReview)
    .set({ currentAssignmentId: null, flags: { ...flags, declinedBySeller: { assignmentId: a.id, sellerUserId: a.sellerUserId, sellerName, reasonKey, reasonLabel, at: at.toISOString() } } })
    .where(reviewWhere(ctx, a.accountId));
  await publish(ctx, assignmentDeclined, { assignmentId: a.id, accountId: a.accountId, sellerUserId: a.sellerUserId, reasonKey, reasonLabel, note });
  await moveStage(ctx, a.accountId, 'assignment_declined', `${a.id}:declined`);
  await publishReviewSnapshot(ctx, a.accountId);
}

/** Ends an open assignment as withdrawn and returns the stage to `reviewed` (Ruling 16), on a locked row. */
async function withdrawLocked(ctx: ModuleContext, a: Assignment, by: string): Promise<void> {
  await endAssignment(ctx, a, 'withdrawn', by, null);
  await ctx.tx.update(accountReview).set({ currentAssignmentId: null }).where(reviewWhere(ctx, a.accountId));
  await moveStage(ctx, a.accountId, 'withdrawn', `${a.id}:withdrawn`);
}

/**
 * The assigner or an owner withdraws an open assignment, optionally giving the account to another seller
 * (REV-E2 rules, REV-E2-S4-AC1). Reassigning goes through `assign`, so its checks and preflight run once
 * and the first assignment ends as `replaced`: `withdrawn` then `created` are published, and one snapshot.
 */
export async function withdraw(
  ctx: ModuleContext,
  assignmentId: string,
  opts: { reassignTo?: string } = {},
): Promise<{ assignmentId: string; reassigned: AssignmentView | null }> {
  const by = requirePerson(ctx);
  const first = await loadAssignment(ctx, assignmentId);
  if (!first) throw notFound();
  await lockForWrite(ctx, first.accountId); // the account must be visible; the row is now locked
  const a = await loadAssignment(ctx, assignmentId);
  if (!a || a.accountId !== first.accountId) throw notFound();
  if (a.assignedBy !== by && !(await members(ctx, { roles: ['owner'] })).some((m) => m.userId === by)) {
    throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Only the person who assigned it, or an owner, can withdraw it.' });
  }
  if (!OPEN_STATUSES.includes(a.status)) throw conflict('That assignment is not open.');

  if (opts.reassignTo) return { assignmentId, reassigned: await assign(ctx, a.accountId, { sellerUserId: opts.reassignTo }) };
  await withdrawLocked(ctx, a, by);
  await publishReviewSnapshot(ctx, a.accountId);
  return { assignmentId, reassigned: null };
}

/**
 * Accepts, with `auto_timeout`, the pending assignments that waited out the tenant's working days
 * (Ruling 6): the oldest first, at most 500. Each review row is locked and `pending` checked again under
 * the lock, so a decline that got there first stands. Returns how many were accepted.
 */
export async function autoAccept(ctx: ModuleContext, now: Date): Promise<number> {
  const [setting] = await ctx.tx.select({ days: routingSetting.autoAcceptWorkingDays }).from(routingSetting).where(eq(routingSetting.tenantId, ctx.tenantId));
  // No row means the default; a row with null days means off.
  const days = setting ? setting.days : DEFAULT_AUTO_ACCEPT_WORKING_DAYS;
  if (!days) return 0;
  const timezone = await tenantTimezone(ctx);

  // N working days is N calendar days later at the same local time, which is an hour less elapsed time where DST shortens a day;
  // two hours of slack covers that, so a candidate is never missed. Due-ness only
  // grows with age, so the due ones are a prefix of the oldest-first list.
  const cutoff = new Date(now.getTime() - (days * 24 - 2) * 3_600_000);
  const candidates = await ctx.tx
    .select()
    .from(assignment)
    .where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.status, 'pending'), lte(assignment.assignedAt, cutoff)))
    .orderBy(asc(assignment.assignedAt), asc(assignment.id))
    .limit(MAX_AUTO_ACCEPT);
  const due = candidates.filter((c) => addWorkingDays(c.assignedAt, days, timezone) <= now);

  let accepted = 0;
  // Locked in account order, as every multi-account write does.
  for (const c of due.sort((x, y) => (x.accountId < y.accountId ? -1 : x.accountId > y.accountId ? 1 : 0))) {
    const row = await lockRow(ctx, c.accountId);
    const a = await loadAssignment(ctx, c.id);
    if (!row || row.mergedInto || !a || a.status !== 'pending' || a.accountId !== c.accountId) continue;
    try {
      await ctx.tx.transaction(async (tx) => {
        const sp = { ...ctx, tx };
        await acceptLocked(sp, a, 'auto_timeout', now);
        await publishReviewSnapshot(sp, a.accountId);
      });
      accepted += 1;
    } catch (e) {
      logFor(ctx).error({ assignmentId: a.id, err: (e as Error).message }, 'auto-accept failed for one assignment');
    }
  }
  return accepted;
}

/** The assigned seller has seen the new arrival: clears "New from" (Ruling 7). No snapshot when nothing was set. */
export async function markSeen(ctx: ModuleContext, accountId: string): Promise<ReviewSnapshot> {
  const by = requirePerson(ctx);
  const row = await lockRow(ctx, accountId);
  const open = row && !row.mergedInto ? await openAssignment(ctx, accountId) : null;
  if (!row || !open || open.sellerUserId !== by) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
  if (!row.flags.newFrom) return currentReviewSnapshot(ctx, accountId);
  await ctx.tx.update(accountReview).set({ flags: sql`${accountReview.flags} - 'newFrom'` }).where(reviewWhere(ctx, accountId));
  return publishReviewSnapshot(ctx, accountId);
}

/** `tenancy.member.removed`: the seller's open assignments are withdrawn, one write (and snapshot) per account. */
export async function withdrawForRemovedMember(ctx: ModuleContext, userId: string, removedBy: string): Promise<void> {
  const open = await ctx.tx
    .select({ id: assignment.id, accountId: assignment.accountId })
    .from(assignment)
    .where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.sellerUserId, userId), inArray(assignment.status, OPEN_STATUSES)));
  for (const { id, accountId } of open.sort((x, y) => (x.accountId < y.accountId ? -1 : 1))) {
    const row = await lockRow(ctx, accountId);
    const a = await loadAssignment(ctx, id);
    if (!row || row.mergedInto || !a || a.accountId !== accountId || a.sellerUserId !== userId || !OPEN_STATUSES.includes(a.status)) continue;
    await withdrawLocked(ctx, a, removedBy);
    await publishReviewSnapshot(ctx, accountId);
  }
}
