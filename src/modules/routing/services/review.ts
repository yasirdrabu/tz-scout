import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { filterVisibleAccountIds, resolveAccountId } from '@/modules/accounts';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { assignmentWithdrawn, statusChanged } from '../contracts/events';
import type { ReviewSnapshot } from '../contracts/types';
import { accountReview, assignment, declineReasonDef, reviewStatusDef, stageChange, statusChange } from '../db/schema';
import { statusChangeProblems, type ReasonDef } from '../domain/status-rules';
import { currentReviewSnapshot, publishReviewSnapshot } from './snapshot';
import { moveStage } from './stage';

export const OPEN_STATUSES = ['pending', 'accepted'];
export const MAX_TEXT = 4000;

type ReviewRow = typeof accountReview.$inferSelect;
export type StatusDef = typeof reviewStatusDef.$inferSelect;

const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
const invalid = (title: string, path: string) => new ScoutError({ slug: 'validation', status: 400, title, errors: [{ path, message: title }] });

/** Review writes come from people only; returns who is acting. */
export function requirePerson(ctx: ModuleContext): string {
  const userId = ctx.access?.userId;
  if (!userId) throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Only a person can do this here.' });
  return userId;
}

export function checkLength(text: string | null | undefined, path: string): void {
  if (text && text.length > MAX_TEXT) throw invalid(`Keep the ${path} to 4,000 characters.`, path);
}

const reviewWhere = (ctx: ModuleContext, accountId: string) => and(eq(accountReview.tenantId, ctx.tenantId), eq(accountReview.accountId, accountId));

/** Locks the account's review row. Null when there is none. */
async function lockRow(ctx: ModuleContext, accountId: string): Promise<ReviewRow | null> {
  const [row] = await ctx.tx.select().from(accountReview).where(reviewWhere(ctx, accountId)).for('update');
  return row ?? null;
}

/**
 * The start of every write a route calls: the account must be visible (else 404) and have a live
 * review row, which is locked. A merged account's row is read-only, so it is not found either.
 */
export async function lockForWrite(ctx: ModuleContext, accountId: string): Promise<ReviewRow> {
  return visibleReview(ctx, accountId, { lock: true });
}

/** The same checks as `lockForWrite`, with or without the row lock (reads go without). */
export async function visibleReview(ctx: ModuleContext, accountId: string, opts: { lock: boolean }): Promise<ReviewRow> {
  if ((await filterVisibleAccountIds(ctx, [accountId])).length === 0) throw notFound();
  const row = opts.lock ? await lockRow(ctx, accountId) : (await ctx.tx.select().from(accountReview).where(reviewWhere(ctx, accountId)))[0];
  if (!row || row.mergedInto) throw notFound();
  return row;
}

type CopiedFields = Partial<Pick<ReviewRow, 'stage' | 'insights' | 'insightsBy' | 'insightsAt' | 'leadOfferOverrideId'>>;

/**
 * Creates the account's review row when it has none (insert or nothing, so the arrival consumer and the
 * backfill can't both create one), then locks it. A merge passes the merged row's stage, insights and
 * lead offer to start from. The caller publishes the snapshot.
 */
export async function ensureReview(
  ctx: ModuleContext,
  accountId: string,
  statusKey: string,
  copy: CopiedFields = {},
): Promise<{ row: ReviewRow; created: boolean }> {
  const inserted = await ctx.tx
    .insert(accountReview)
    .values({ tenantId: ctx.tenantId, accountId, statusKey, stage: 'arrived', ...copy })
    .onConflictDoNothing()
    .returning({ accountId: accountReview.accountId });
  return { row: (await lockRow(ctx, accountId))!, created: inserted.length > 0 };
}

/** Every status the tenant has, archived ones included (an account may still hold one), in order. */
export async function loadStatuses(ctx: ModuleContext): Promise<StatusDef[]> {
  return ctx.tx.select().from(reviewStatusDef).where(eq(reviewStatusDef.tenantId, ctx.tenantId)).orderBy(asc(reviewStatusDef.order), asc(reviewStatusDef.key));
}

export async function openAssignment(ctx: ModuleContext, accountId: string) {
  const [open] = await ctx.tx
    .select()
    .from(assignment)
    .where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.accountId, accountId), inArray(assignment.status, OPEN_STATUSES)));
  return open ?? null;
}

/**
 * Ends an open assignment as withdrawn or replaced and publishes `routing.assignment.withdrawn`.
 * "New from" belongs to the assignment, so it ends with it.
 */
export async function endAssignment(
  ctx: ModuleContext,
  open: { id: string; accountId: string },
  status: 'withdrawn' | 'replaced',
  by: string,
  replacedBy: string | null,
): Promise<void> {
  await ctx.tx.update(assignment).set({ status, respondedAt: new Date() }).where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.id, open.id)));
  await ctx.tx.update(accountReview).set({ flags: sql`${accountReview.flags} - 'newFrom'` }).where(reviewWhere(ctx, open.accountId));
  await publish(ctx, assignmentWithdrawn, { assignmentId: open.id, accountId: open.accountId, by, replacedBy });
}

/** The sender closest to the arrival: the agent, else the vendor, else the person. */
const closestSource = (c: { personSourceId?: string; agentSourceId?: string; vendorSourceId?: string }) =>
  c.agentSourceId ?? c.vendorSourceId ?? c.personSourceId;

/**
 * `intake.arrival.resolved`: a new review row starts at the arrival's initial status when it names an
 * active status, else `unvetted` (Ruling 5). An arrival on an account with an open assignment sets
 * "New from" (Ruling 7). Anything else leaves the review alone.
 */
export async function reviewOnArrival(
  ctx: ModuleContext,
  e: { accountId: string; initialReviewStatusKey: string; sourceChain: { personSourceId?: string; agentSourceId?: string; vendorSourceId?: string }; at: string },
): Promise<void> {
  const accountId = (await resolveAccountId(ctx, e.accountId))?.id;
  if (!accountId) return;
  const statuses = await loadStatuses(ctx);
  const initial = statuses.some((s) => s.key === e.initialReviewStatusKey && !s.archivedAt) ? e.initialReviewStatusKey : 'unvetted';
  const { row, created } = await ensureReview(ctx, accountId, initial);
  if (created) {
    await publishReviewSnapshot(ctx, accountId);
    return;
  }
  const sourceId = closestSource(e.sourceChain);
  if (row.mergedInto || !sourceId || !(await openAssignment(ctx, accountId))) return;
  await ctx.tx.update(accountReview).set({ flags: { ...row.flags, newFrom: { sourceId, at: e.at } } }).where(reviewWhere(ctx, accountId));
  await publishReviewSnapshot(ctx, accountId);
}

/**
 * `accounts.account.merged`: the survivor keeps its review row. The merged account's open assignment
 * moves over when the survivor has none, else it is withdrawn. Its history (status changes, stage
 * changes, ended assignments) is re-pointed to the survivor; its own row stays, read-only, with
 * `merged_into` set. Both accounts get a snapshot.
 */
export async function reviewOnMerge(ctx: ModuleContext, survivorId: string, mergedId: string, by: string, causeId: string): Promise<void> {
  // Lock both rows in id order, as every multi-account write does.
  const locked = new Map<string, ReviewRow | null>();
  for (const id of [survivorId, mergedId].sort()) locked.set(id, await lockRow(ctx, id));
  const merged = locked.get(mergedId);
  if (!merged || merged.mergedInto) return;
  const { row: survivor, created } = await ensureReview(ctx, survivorId, merged.statusKey, {
    stage: merged.stage,
    insights: merged.insights,
    insightsBy: merged.insightsBy,
    insightsAt: merged.insightsAt,
    leadOfferOverrideId: merged.leadOfferOverrideId,
  });

  // The assignment moves only to a survivor with none open that can be assigned (not declined, Ruling 14).
  const moving = await openAssignment(ctx, mergedId);
  const kept = created ? null : await openAssignment(ctx, survivorId);
  const survivorDeclined = (await loadStatuses(ctx)).find((s) => s.key === survivor.statusKey)?.isDeclined ?? false;
  let moved: typeof moving = null;
  if (moving && (kept || survivorDeclined)) await endAssignment(ctx, moving, 'withdrawn', by, null);
  else moved = moving;

  const repoint = { accountId: survivorId };
  await ctx.tx.update(assignment).set(repoint).where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.accountId, mergedId)));
  await ctx.tx.update(statusChange).set(repoint).where(and(eq(statusChange.tenantId, ctx.tenantId), eq(statusChange.accountId, mergedId)));
  await ctx.tx.update(stageChange).set(repoint).where(and(eq(stageChange.tenantId, ctx.tenantId), eq(stageChange.accountId, mergedId)));
  await ctx.tx.update(accountReview).set({ mergedInto: survivorId, currentAssignmentId: null }).where(reviewWhere(ctx, mergedId));
  if (moved) {
    await ctx.tx.update(accountReview).set({ currentAssignmentId: moved.id }).where(reviewWhere(ctx, survivorId));
    if (moved.status === 'accepted') await moveStage(ctx, survivorId, 'assigned', causeId);
  }
  await publishReviewSnapshot(ctx, survivorId);
  await publishReviewSnapshot(ctx, mergedId);
}

export type StatusChangeInput = { to: string; note?: string | null; reasonKey?: string | null };

/**
 * Changes an account's review status (REV-E1-S2). Reopening a declined account needs a note and lands
 * on Needs review, with the stage back to arrived. A declined status first withdraws an open
 * assignment, then moves the status and the stage (one move, straight to declined; Ruling 14).
 */
export async function changeStatus(ctx: ModuleContext, accountId: string, input: StatusChangeInput): Promise<ReviewSnapshot> {
  const by = requirePerson(ctx);
  const row = await lockForWrite(ctx, accountId);
  if (!(await applyStatusChange(ctx, row, input, by))) return currentReviewSnapshot(ctx, accountId);
  return publishReviewSnapshot(ctx, accountId);
}

/**
 * The status change itself, on a locked row, without the snapshot (the calling write publishes it).
 * `assign` uses it for "Approve and assign". Returns false, having written nothing, when the account
 * already has that status.
 */
export async function applyStatusChange(ctx: ModuleContext, row: ReviewRow, input: StatusChangeInput, by: string): Promise<boolean> {
  const note = input.note?.trim() || null;
  const reasonKey = input.reasonKey?.trim() || null;
  checkLength(note, 'note');
  const statuses = await loadStatuses(ctx);
  let target = statuses.find((s) => s.key === input.to && !s.archivedAt);
  if (!target) throw invalid('Pick a review status from your list.', 'to');
  const current = statuses.find((s) => s.key === row.statusKey);

  const reopening = !!current?.isDeclined && !target.isDeclined;
  if (reopening) {
    if (!note) throw invalid("Add a note saying why you're reopening it.", 'note');
    target = statuses.find((s) => s.key === 'needs_review' && !s.archivedAt) ?? statuses.find((s) => !s.archivedAt && !s.countsAsReviewed) ?? target;
  }
  if (target.key === row.statusKey) return false;
  const reasonDefs = (await ctx.tx.select().from(declineReasonDef).where(eq(declineReasonDef.tenantId, ctx.tenantId))) as ReasonDef[];
  const problems = statusChangeProblems(target, { note, reasonKey, reasonDefs });
  if (problems.length > 0) {
    throw new ScoutError({
      slug: 'validation',
      status: 400,
      title: problems[0]!,
      errors: problems.map((message) => ({ path: message === 'Pick a reason' ? 'reason_key' : 'note', message })),
    });
  }

  const accountId = row.accountId;
  const changeId = newId('rsc');
  if (target.isDeclined) {
    const open = await openAssignment(ctx, accountId);
    if (open) {
      await endAssignment(ctx, open, 'withdrawn', by, null);
      await ctx.tx.update(accountReview).set({ currentAssignmentId: null }).where(reviewWhere(ctx, accountId));
    }
  }
  await ctx.tx.update(accountReview).set({ statusKey: target.key, statusChangedAt: new Date(), statusChangedBy: by }).where(reviewWhere(ctx, accountId));
  await ctx.tx.insert(statusChange).values({ id: changeId, tenantId: ctx.tenantId, accountId, fromKey: row.statusKey, toKey: target.key, note, reasonKey: target.isDeclined ? reasonKey : null, by });
  const event = reopening ? 'reopened' : target.isDeclined ? 'declined' : target.countsAsReviewed ? 'reviewed' : null;
  if (event) await moveStage(ctx, accountId, event, changeId);
  await publish(ctx, statusChanged, {
    accountId,
    from: row.statusKey,
    to: target.key,
    countsAsReviewed: target.countsAsReviewed,
    isDeclined: target.isDeclined,
    returnsToSource: target.returnsToSource,
    note,
    reasonKey: target.isDeclined ? reasonKey : null,
    by,
  });
  return true;
}

export type InsightsView = { insights: string | null; insightsBy: string | null; insightsAt: Date | null };

/** Leader insights (REV-E1-S3-AC1): free text with author and time. Empty text clears them. */
export async function setInsights(ctx: ModuleContext, accountId: string, text: string): Promise<InsightsView> {
  const by = requirePerson(ctx);
  checkLength(text, 'insights');
  await lockForWrite(ctx, accountId);
  const insights = text.trim() || null;
  const [row] = await ctx.tx
    .update(accountReview)
    .set({ insights, insightsBy: by, insightsAt: new Date() })
    .where(reviewWhere(ctx, accountId))
    .returning({ insights: accountReview.insights, insightsBy: accountReview.insightsBy, insightsAt: accountReview.insightsAt });
  await publishReviewSnapshot(ctx, accountId);
  return row!;
}
