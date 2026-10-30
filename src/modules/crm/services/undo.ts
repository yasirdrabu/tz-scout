import { and, eq, isNull, sql } from 'drizzle-orm';
import { getAccount, type PersonView } from '@/modules/accounts';
import { gateway } from '@/modules/integrations';
import { crmOwnerId, members, tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { withTenant } from '@/platform/db/tenant';
import { enqueueJob, publish } from '@/platform/events/outbox';
import { log } from '@/platform/log';
import type { CrmAdapter } from '../contracts/adapter';
import { handoffCancelled } from '../contracts/events';
import { handoffUndoJob, UNDO_MAX_ATTEMPTS } from '../contracts/jobs';
import type { HandoffUndone } from '../contracts/types';
import { handoff, link } from '../db/schema';
import { esc } from '../domain/note';
import { classifyPushError, REASON_LIMIT, RETRIES_FAILED } from '../domain/push-errors';
import { refreshBatch } from './batches';
import { byId, cancelHandoff, lockAccount, OPEN, transactionClosed } from './handoff';
import { getLinks, recordLink } from './links';
import { isOwnerActive } from './owners';

/** Why a handoff is undone: the seller declined (with the reason's label), or the assignment was withdrawn. */
export type UndoReason = { kind: 'declined' | 'withdrawn'; reasonLabel: string | null; by: string | null };

type Handoff = typeof handoff.$inferSelect;

/** Links committed as the undo goes, so a retried undo neither adds a second note nor mistakes its own closed tasks for a rep's. */
const UNDO_NOTE = 'undo_note';
const UNDO_TASK = 'undo_task';

const personName = (p: PersonView) => [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || '';
const subject = (h: Handoff) => ({ type: 'account', id: h.accountId });

/**
 * `routing.assignment.declined` or `.withdrawn` (Ruling 6). One short write, with no account lock and nothing
 * held while waiting for one: a handoff still `queued` never started, so it ends here as `cancelled`; any
 * other gets `cancel_requested_at` (a running push stops before its next write; on a finished one it marks
 * the undo as requested) and the `crm.handoff.undo` job, which waits for the push's account lock.
 */
export async function requestUndo(ctx: ModuleContext, input: { assignmentId: string } & UndoReason, now: Date = new Date()): Promise<void> {
  const [h] = await ctx.tx
    .select()
    .from(handoff)
    .where(and(eq(handoff.tenantId, ctx.tenantId), eq(handoff.assignmentId, input.assignmentId)));
  if (!h) return;
  const [stopped] = await ctx.tx
    .update(handoff)
    .set({ status: 'cancelled', cancelRequestedAt: now })
    .where(and(byId(ctx, h.id), eq(handoff.status, 'queued')))
    .returning();
  if (stopped) {
    await publish(ctx, handoffCancelled, { handoffId: h.id, accountId: h.accountId, assignmentId: h.assignmentId, at: now.toISOString() }, subject(h));
    if (h.handoffBatchId) await refreshBatch(ctx, h.handoffBatchId);
    return;
  }
  await ctx.tx.update(handoff).set({ cancelRequestedAt: now }).where(and(byId(ctx, h.id), isNull(handoff.cancelRequestedAt)));
  await enqueueJob(ctx, handoffUndoJob, { handoffId: h.id, kind: input.kind, reasonLabel: input.reasonLabel, by: input.by });
}

/**
 * The `crm.handoff.undo` job (Ruling 7, CRM-E3-S7). Counts the run in its own transaction, then takes the
 * account lock, so a push still running finishes its current write and stops; a push that never got to stop
 * is ended as `cancelled` here. Then, from what the links show was written: closes this assignment's open
 * tasks, gives ownership back while the company is still our seller's (people first, the company last, so a
 * retry still sees it as ours), adds one short note and records `undone`. Nothing is deleted and the context
 * note is never edited. A retryable error is rethrown until the last run, which records the failure in
 * `undone`; a handoff already undone is left alone.
 */
export async function runUndo(ctx: ModuleContext, handoffId: string, now: Date, why: UndoReason): Promise<void> {
  const run = await withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .update(handoff)
      .set({ undoAttempts: sql`${handoff.undoAttempts} + 1` })
      .where(and(byId(ctx, handoffId), isNull(handoff.undone)))
      .returning();
    return row ?? null;
  });
  if (!run) return; // gone, or already undone
  if (run.undoAttempts > UNDO_MAX_ATTEMPTS) {
    await failUndo(ctx, run.id, now, RETRIES_FAILED);
    return;
  }
  try {
    await lockAccount(ctx, run.accountId);
    let [h] = await ctx.tx.select().from(handoff).where(byId(ctx, handoffId));
    if (!h || h.undone) return;
    if (OPEN.includes(h.status)) {
      await cancelHandoff(ctx, h, now);
      [h] = await ctx.tx.select().from(handoff).where(byId(ctx, handoffId));
    }
    const undone = await undoWrites(ctx, h!, now, why);
    await record(ctx, h!, undone, now);
  } catch (e) {
    if (transactionClosed(e)) throw e;
    const f = classifyPushError(e);
    if (f.unexpected) log.error({ err: e, tenantId: ctx.tenantId, handoffId }, 'crm: handoff undo failed unexpectedly');
    if (f.retryable && run.undoAttempts < UNDO_MAX_ATTEMPTS) throw e;
    if (!(await failUndo(ctx, handoffId, now, f.retryable ? RETRIES_FAILED : f.reason))) throw e;
  }
}

/**
 * Stores `undone` once and refreshes the batch. A handoff the push had finished (completed, failed or
 * needs_decision) also publishes `crm.handoff.cancelled` here, once; one already cancelled was announced by
 * `cancelHandoff` or by the push itself. One still open (only when giving up) is cancelled here too.
 */
async function record(ctx: ModuleContext, h: Handoff, undone: HandoffUndone, now: Date): Promise<void> {
  const set = OPEN.includes(h.status) ? { undone, status: 'cancelled' } : { undone };
  const wrote = await ctx.tx.update(handoff).set(set).where(and(byId(ctx, h.id), isNull(handoff.undone))).returning({ id: handoff.id });
  if (wrote.length === 0) return;
  if (!OPEN.includes(h.status) && h.status !== 'cancelled') {
    await publish(ctx, handoffCancelled, { handoffId: h.id, accountId: h.accountId, assignmentId: h.assignmentId, at: now.toISOString() }, subject(h));
  }
  if (h.handoffBatchId) await refreshBatch(ctx, h.handoffBatchId);
}

/**
 * The last run gave up: records what had been done and why, in a transaction of its own (the job's may be
 * aborted). False when the job's own transaction holds the row (it wrote `undone` before failing): waiting
 * for it would never end, so the caller rethrows and the platform keeps the job.
 */
async function failUndo(ctx: ModuleContext, handoffId: string, now: Date, reason: string): Promise<boolean> {
  return withTenant(ctx.tenantId, async (tx) => {
    const c = { ...ctx, tx };
    const [current] = await tx.select().from(handoff).where(byId(c, handoffId)).for('update', { skipLocked: true });
    if (!current) return false;
    if (current.undone) return true;
    const done = await undoLinks(c, current);
    await record(c, current, { ...emptyUndone(now), tasksClosed: done.tasks, noteExternalId: done.note, failed: true, reason: reason.slice(0, REASON_LIMIT) }, now);
    return true;
  });
}

const emptyUndone = (now: Date): HandoffUndone => ({ tasksClosed: [], tasksLeftDone: [], ownerReturnedTo: null, noteExternalId: null, ownerNote: null, at: now.toISOString() });

/** What earlier runs of this undo committed: the tasks it closed and its note. */
async function undoLinks(ctx: ModuleContext, h: Handoff): Promise<{ tasks: string[]; note: string | null }> {
  const rows = await ctx.tx
    .select({ type: link.scoutType, externalId: link.externalId })
    .from(link)
    .where(and(eq(link.tenantId, ctx.tenantId), eq(link.system, h.system), eq(link.scoutId, h.id)));
  return { tasks: rows.filter((r) => r.type === UNDO_TASK).map((r) => r.externalId), note: rows.find((r) => r.type === UNDO_NOTE)?.externalId ?? null };
}

async function undoWrites(ctx: ModuleContext, h: Handoff, now: Date, why: UndoReason): Promise<HandoffUndone> {
  const system = h.system;
  const out = emptyUndone(now);
  const links = await getLinks(ctx, h.accountId);
  const companyId = h.companyExternalId ?? (links.company?.system === system ? links.company.externalId : null);
  if (!companyId) return out; // the company is the first write: nothing was written

  const call = <T>(op: string, fn: (a: CrmAdapter) => Promise<T>) => gateway.call(ctx, system, op, (a) => fn(a as CrmAdapter), { module: 'crm' });
  const before = await undoLinks(ctx, h);
  const tasks = links.tasks.filter((l) => l.system === system && l.scoutId.startsWith(`${h.assignmentId}:`));
  const ft = await call('readFollowThrough', (a) => a.readFollowThrough({ companyExternalId: companyId, taskExternalIds: tasks.map((l) => l.externalId) }));

  // Tasks: a person's completed task stays as it is; a task gone from the CRM is skipped.
  const closeNote = why.kind === 'declined' ? `Declined in Scout: ${why.reasonLabel ?? 'No reason given'}` : 'Withdrawn in Scout';
  for (const l of tasks) {
    const status = ft.tasks.find((x) => x.externalId === l.externalId)?.status;
    if (before.tasks.includes(l.externalId)) out.tasksClosed.push(l.externalId);
    else if (status === 'completed') out.tasksLeftDone.push(l.externalId);
    else if (status === 'open') {
      await call('closeTask', (a) => a.closeTask({ externalId: l.externalId, note: closeNote }));
      await recordLink(ctx, { scoutType: UNDO_TASK, scoutId: h.id, system, externalId: l.externalId });
      out.tasksClosed.push(l.externalId);
    }
  }

  // Ownership goes back only when Scout took it and the company is still our seller's, or (on a retry) is
  // already with the owner it goes back to. People first: the company stays ours until the last write.
  const sellerOwner = h.sellerUserId ? await crmOwnerId(ctx, h.sellerUserId, system) : null;
  const ours = !!sellerOwner && ft.ownerExternalId === sellerOwner;
  const people = await members(ctx);
  const nameOf = (userId: string | null) => people.find((m) => m.userId === userId)?.name ?? null;
  let resumed = false;
  if (h.ownershipAction === 'assign') {
    const back = h.takenFromOwner && (await isOwnerActive(ctx, system, h.takenFromOwner)) !== false ? h.takenFromOwner : null;
    const to = back ?? (h.assignedBy ? await crmOwnerId(ctx, h.assignedBy, system) : null);
    resumed = !!to && h.undoAttempts > 1 && ft.ownerExternalId === to;
    const account = await getAccount(ctx, h.accountId);
    if (!to && ours) out.ownerNote = `Owner left as is: ${nameOf(h.assignedBy) ?? 'the assigner'} has no HubSpot owner`;
    else if (to && (ours || resumed) && account?.domain) {
      for (const p of account.people) {
        const linked = links.people.find((l) => l.scoutId === p.id && l.system === system);
        const name = personName(p);
        if (!linked || !name) continue;
        const found = await call('findPerson', (a) => a.findPerson(p.email ? { email: p.email } : { name, companyExternalId: companyId }));
        if (found?.externalId !== linked.externalId || found.ownerExternalId !== sellerOwner) continue; // returned already, or someone else set it
        await call('upsertPerson', (a) => a.upsertPerson({ externalId: linked.externalId, name, ownerExternalId: to, takeOverOwner: true, companyExternalId: companyId }));
      }
      if (ours) {
        await call('upsertCompany', (a) =>
          a.upsertCompany({ externalId: companyId, domain: account.domain!, name: account.name, ownerExternalId: to, replaceableOwner: true, properties: {} }),
        );
      }
      out.ownerReturnedTo = to;
    }
  }

  // One short note of its own, only when the push wrote something here.
  if (h.status === 'completed' || tasks.length > 0 || ours || resumed) {
    out.noteExternalId = before.note ?? (await undoNote(ctx, h, companyId, now, why, nameOf, call));
  }
  return out;
}

async function undoNote(
  ctx: ModuleContext,
  h: Handoff,
  companyId: string,
  now: Date,
  why: UndoReason,
  nameOf: (userId: string | null) => string | null,
  call: <T>(op: string, fn: (a: CrmAdapter) => Promise<T>) => Promise<T>,
): Promise<string> {
  const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: await tenantTimezone(ctx) });
  const line =
    why.kind === 'declined'
      ? `Returned by ${nameOf(h.sellerUserId) ?? 'the seller'} on ${date}: ${why.reasonLabel ?? 'No reason given'}`
      : `Withdrawn by ${nameOf(why.by ?? h.assignedBy) ?? 'the assigner'} on ${date}`;
  const note = await call('upsertNote', (a) => a.upsertNote({ companyExternalId: companyId, html: `<p>${esc(line)}</p>`, ownerExternalId: null }));
  await recordLink(ctx, { scoutType: UNDO_NOTE, scoutId: h.id, system: h.system, externalId: note.externalId });
  return note.externalId;
}
