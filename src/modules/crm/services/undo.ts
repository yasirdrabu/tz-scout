import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getAccount, type PersonView } from '@/modules/accounts';
import { gateway } from '@/modules/integrations';
import { crmOwnerId, members, tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { enqueueJob, publish } from '@/platform/events/outbox';
import type { CrmAdapter } from '../contracts/adapter';
import { handoffCancelled } from '../contracts/events';
import { handoffUndoJob } from '../contracts/jobs';
import type { HandoffUndone } from '../contracts/types';
import { handoff, link } from '../db/schema';
import { esc } from '../domain/note';
import { refreshBatch } from './batches';
import { byId, cancelHandoff, lockAccount, OPEN } from './handoff';
import { getLinks, recordLink } from './links';
import { isOwnerActive } from './owners';

/** Why a handoff is undone: the seller declined (with the reason's label), or the assignment was withdrawn. */
export type UndoReason = { kind: 'declined' | 'withdrawn'; reasonLabel: string | null; by: string | null };

type Handoff = typeof handoff.$inferSelect;

/** The link that remembers the undo's short note, so a retried undo doesn't add a second one. */
const UNDO_NOTE = 'undo_note';

const personName = (p: PersonView) => [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || '';

/**
 * `routing.assignment.declined` or `.withdrawn` (Ruling 6). One short write, with no account lock and nothing
 * held while waiting for one: a handoff still `queued` never started, so it ends here as `cancelled`; any
 * other gets `cancel_requested_at` (only while running, so the push stops before its next write) and the
 * `crm.handoff.undo` job, which waits for the push's account lock and undoes what was written.
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
    await publish(ctx, handoffCancelled, { handoffId: h.id, accountId: h.accountId, assignmentId: h.assignmentId, at: now.toISOString() }, { type: 'account', id: h.accountId });
    if (h.handoffBatchId) await refreshBatch(ctx, h.handoffBatchId);
    return;
  }
  await ctx.tx
    .update(handoff)
    .set({ cancelRequestedAt: now })
    .where(and(byId(ctx, h.id), inArray(handoff.status, OPEN), isNull(handoff.cancelRequestedAt)));
  await enqueueJob(ctx, handoffUndoJob, { handoffId: h.id, kind: input.kind, reasonLabel: input.reasonLabel, by: input.by });
}

/**
 * The `crm.handoff.undo` job (Ruling 7, CRM-E3-S7). Takes the account lock first, so a push still running
 * finishes its current write and stops; a push that never got to stop is ended as `cancelled` here. Then,
 * from what the links show was written: closes this assignment's open tasks, gives ownership back when the
 * company is still our seller's, adds one short note and records `undone`. Nothing is deleted and the
 * context note is never edited. A handoff already undone is left alone.
 */
export async function runUndo(ctx: ModuleContext, handoffId: string, now: Date, why: UndoReason): Promise<void> {
  const [first] = await ctx.tx.select({ accountId: handoff.accountId }).from(handoff).where(byId(ctx, handoffId));
  if (!first) return;
  await lockAccount(ctx, first.accountId);
  const [h] = await ctx.tx.select().from(handoff).where(byId(ctx, handoffId));
  if (!h || h.undone) return;
  if (OPEN.includes(h.status)) await cancelHandoff(ctx, h, now);

  const undone = await undoWrites(ctx, h, now, why);
  await ctx.tx.update(handoff).set({ undone }).where(byId(ctx, h.id));
  if (h.handoffBatchId) await refreshBatch(ctx, h.handoffBatchId);
}

async function undoWrites(ctx: ModuleContext, h: Handoff, now: Date, why: UndoReason): Promise<HandoffUndone> {
  const system = h.system;
  const out: HandoffUndone = { tasksClosed: [], tasksLeftDone: [], ownerReturnedTo: null, noteExternalId: null, ownerNote: null, at: now.toISOString() };
  const links = await getLinks(ctx, h.accountId);
  const companyId = h.companyExternalId ?? (links.company?.system === system ? links.company.externalId : null);
  if (!companyId) return out; // the company is the first write: nothing was written

  const call = <T>(op: string, fn: (a: CrmAdapter) => Promise<T>) => gateway.call(ctx, system, op, (a) => fn(a as CrmAdapter), { module: 'crm' });
  const tasks = links.tasks.filter((l) => l.system === system && l.scoutId.startsWith(`${h.assignmentId}:`));
  const ft = await call('readFollowThrough', (a) => a.readFollowThrough({ companyExternalId: companyId, taskExternalIds: tasks.map((l) => l.externalId) }));

  // Tasks: a person's completed task stays as it is; a task gone from the CRM is skipped.
  const closeNote = why.kind === 'declined' ? `Declined in Scout: ${why.reasonLabel ?? 'No reason given'}` : 'Withdrawn in Scout';
  for (const l of tasks) {
    const status = ft.tasks.find((x) => x.externalId === l.externalId)?.status;
    if (status === 'completed') out.tasksLeftDone.push(l.externalId);
    else if (status === 'open') {
      await call('closeTask', (a) => a.closeTask({ externalId: l.externalId, note: closeNote }));
      out.tasksClosed.push(l.externalId);
    }
  }

  // Ownership goes back only when Scout took it and the company is still our seller's.
  const sellerOwner = h.sellerUserId ? await crmOwnerId(ctx, h.sellerUserId, system) : null;
  const ours = !!sellerOwner && ft.ownerExternalId === sellerOwner;
  const people = await members(ctx);
  const nameOf = (userId: string | null) => people.find((m) => m.userId === userId)?.name ?? null;
  const account = await getAccount(ctx, h.accountId);
  if (h.ownershipAction === 'assign' && ours && account?.domain) {
    const back = h.takenFromOwner && (await isOwnerActive(ctx, system, h.takenFromOwner)) !== false ? h.takenFromOwner : null;
    const to = back ?? (h.assignedBy ? await crmOwnerId(ctx, h.assignedBy, system) : null);
    if (!to) out.ownerNote = `Owner left as is: ${nameOf(h.assignedBy) ?? 'the assigner'} has no HubSpot owner`;
    else {
      await call('upsertCompany', (a) =>
        a.upsertCompany({ externalId: companyId, domain: account.domain!, name: account.name, ownerExternalId: to, replaceableOwner: true, properties: {} }),
      );
      for (const p of account.people) {
        const linked = links.people.find((l) => l.scoutId === p.id && l.system === system);
        const name = personName(p);
        if (!linked || !name) continue;
        const found = await call('findPerson', (a) => a.findPerson(p.email ? { email: p.email } : { name, companyExternalId: companyId }));
        if (found?.externalId !== linked.externalId || found.ownerExternalId !== sellerOwner) continue; // someone else set it since
        await call('upsertPerson', (a) => a.upsertPerson({ externalId: linked.externalId, name, ownerExternalId: to, takeOverOwner: true, companyExternalId: companyId }));
      }
      out.ownerReturnedTo = to;
    }
  }

  // One short note of its own, only when the push wrote something here.
  if (h.status === 'completed' || tasks.length > 0 || ours) out.noteExternalId = await undoNote(ctx, h, companyId, now, why, nameOf, call);
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
  const [have] = await ctx.tx
    .select({ externalId: link.externalId })
    .from(link)
    .where(and(eq(link.tenantId, ctx.tenantId), eq(link.system, h.system), eq(link.scoutType, UNDO_NOTE), eq(link.scoutId, h.id)));
  if (have) return have.externalId;
  const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: await tenantTimezone(ctx) });
  const line =
    why.kind === 'declined'
      ? `Returned by ${nameOf(h.sellerUserId) ?? 'the seller'} on ${date}: ${why.reasonLabel ?? 'No reason given'}`
      : `Withdrawn by ${nameOf(why.by ?? h.assignedBy) ?? 'the assigner'} on ${date}`;
  const note = await call('upsertNote', (a) => a.upsertNote({ companyExternalId: companyId, html: `<p>${esc(line)}</p>`, ownerExternalId: null }));
  await recordLink(ctx, { scoutType: UNDO_NOTE, scoutId: h.id, system: h.system, externalId: note.externalId });
  return note.externalId;
}
