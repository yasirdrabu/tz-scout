import { and, eq, sql } from 'drizzle-orm';
import { getSummaries } from '@/modules/accounts';
import { getOffer } from '@/modules/offers';
import { members } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { assignmentCreated } from '../contracts/events';
import { ownershipPreflight, type OwnershipPreflightResult } from '../contracts/ports';
import { accountReview, assignment } from '../db/schema';
import {
  applyStatusChange,
  changeStatus,
  checkLength,
  endAssignment,
  loadStatuses,
  lockForWrite,
  openAssignment,
  requirePerson,
  visibleReview,
  type StatusChangeInput,
} from './review';
import { publishReviewSnapshot } from './snapshot';
import { moveStage } from './stage';

export const MAX_BULK = 50;

export type AssignInput = { sellerUserId: string; notes?: string | null; leadOfferId?: string | null; ownershipDecision?: 'assign' | 'keep' };

export type AssignmentView = {
  id: string;
  accountId: string;
  sellerUserId: string;
  assignedBy: string;
  status: string;
  notes: string | null;
  offerId: string | null;
  ownershipDecision: 'assign' | 'keep';
  previousAssignmentId: string | null;
};

export type AssignPreview = {
  preflight: OwnershipPreflightResult;
  /** The status "Approve and assign" moves the account to, or null when it already counts as reviewed. */
  approvesTo: { key: string; label: string } | null;
  /** The open assignment this one would replace. */
  replaces: { assignmentId: string; sellerUserId: string } | null;
};

const invalid = (title: string, path: string) => new ScoutError({ slug: 'validation', status: 400, title, errors: [{ path, message: title }] });
const conflict = (title: string) => new ScoutError({ slug: 'conflict', status: 409, title });

/** SQLSTATE 23505 on the named index, whether the driver error is wrapped or not. */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  const err = e as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } } | null;
  return [err, err?.cause].some((x) => x?.code === '23505' && x.constraint_name === constraint);
}

/** The seller must be an active member (not just invited) who can take assignments. */
async function checkSeller(ctx: ModuleContext, sellerUserId: string): Promise<void> {
  const sellers = await members(ctx, { permission: 'assignments:respond' });
  if (!sellers.some((m) => m.userId === sellerUserId && m.status === 'active')) throw invalid('Pick a seller who can take assignments.', 'seller_user_id');
}

/** What assigning would do, on a review row the caller has read (and, for a write, locked). */
async function plan(ctx: ModuleContext, row: { accountId: string; statusKey: string }, sellerUserId: string): Promise<AssignPreview & { open: Awaited<ReturnType<typeof openAssignment>> }> {
  await checkSeller(ctx, sellerUserId);
  const statuses = await loadStatuses(ctx);
  const current = statuses.find((s) => s.key === row.statusKey);
  if (current?.isDeclined) throw conflict('Reopen it before assigning.');
  const approve = current?.countsAsReviewed ? undefined : statuses.find((s) => !s.archivedAt && s.countsAsReviewed && !s.isDeclined);
  const preflight = await ownershipPreflight().check(ctx, row.accountId, sellerUserId);
  const open = await openAssignment(ctx, row.accountId);
  return {
    preflight,
    approvesTo: approve ? { key: approve.key, label: approve.label } : null,
    replaces: open ? { assignmentId: open.id, sellerUserId: open.sellerUserId } : null,
    open,
  };
}

/** What the assign dialog shows before submit: the preflight, the approval and the assignment it replaces. */
export async function previewAssign(ctx: ModuleContext, accountId: string, sellerUserId: string): Promise<AssignPreview> {
  requirePerson(ctx);
  const row = await visibleReview(ctx, accountId, { lock: false });
  const { open: _open, ...preview } = await plan(ctx, row, sellerUserId);
  return preview;
}

async function checkLeadOffer(ctx: ModuleContext, offerId: string): Promise<void> {
  const offer = await getOffer(ctx, offerId).catch((e: unknown) => {
    if (e instanceof ScoutError && e.status === 404) return null;
    throw e;
  });
  if (offer?.status !== 'approved') throw invalid('Pick an approved offer.', 'lead_offer_id');
}

/**
 * Assigns an account to a seller (REV-E2-S1). An account not yet reviewed is approved in the same step
 * (the first status that counts as reviewed and is not declined); a declined one is refused (Ruling 14).
 * The ownership preflight runs first: `blocked`, or `stop` without "keep their owner", is a 409 with
 * its message. An open assignment is replaced. The seller's decline flag clears; a lead offer is
 * stored as the account's override. One snapshot at the end.
 */
export async function assign(ctx: ModuleContext, accountId: string, input: AssignInput, opts: { bulkId?: string } = {}): Promise<AssignmentView> {
  const by = requirePerson(ctx);
  const notes = input.notes?.trim() || null;
  checkLength(notes, 'notes');
  const row = await lockForWrite(ctx, accountId);
  const p = await plan(ctx, row, input.sellerUserId);
  const ownershipDecision = input.ownershipDecision ?? 'assign';
  if (p.preflight.result === 'blocked' || (p.preflight.result === 'stop' && ownershipDecision !== 'keep')) throw conflict(p.preflight.message);
  if (input.leadOfferId) await checkLeadOffer(ctx, input.leadOfferId);

  if (p.approvesTo) await applyStatusChange(ctx, row, { to: p.approvesTo.key }, by);
  const id = newId('asg');
  if (p.open) {
    await endAssignment(ctx, p.open, 'replaced', by, id);
    // The new assignment is pending, so an accepted one going away takes the stage back to reviewed.
    if (p.open.status === 'accepted') await moveStage(ctx, accountId, 'withdrawn', `${p.open.id}:replaced`);
  }
  const values = {
    id,
    tenantId: ctx.tenantId,
    accountId,
    sellerUserId: input.sellerUserId,
    assignedBy: by,
    notes,
    templateId: null,
    ownershipDecision,
    previousAssignmentId: p.open?.id ?? null,
  };
  try {
    await ctx.tx.insert(assignment).values(values);
  } catch (e) {
    // The row lock serialises assigns, so this is the index's last word on a write that went around it.
    if (isUniqueViolation(e, 'assignment_open_uq')) throw conflict('Someone else just assigned this account. Try again.');
    throw e;
  }

  const leadOfferOverrideId = input.leadOfferId ?? row.leadOfferOverrideId;
  // In SQL, so the "New from" that ending the replaced assignment cleared stays cleared.
  await ctx.tx
    .update(accountReview)
    .set({ currentAssignmentId: id, flags: sql`${accountReview.flags} - 'declinedBySeller'`, leadOfferOverrideId })
    .where(and(eq(accountReview.tenantId, ctx.tenantId), eq(accountReview.accountId, accountId)));
  const offerId = leadOfferOverrideId ?? (await getSummaries(ctx, [accountId]))[0]?.bestOfferId ?? null;
  await publish(ctx, assignmentCreated, {
    assignmentId: id,
    accountId,
    sellerUserId: input.sellerUserId,
    assignedBy: by,
    templateId: null,
    offerId,
    notes,
    ownershipDecision,
    previousAssignmentId: values.previousAssignmentId,
    bulkId: opts.bulkId ?? null,
  });
  await publishReviewSnapshot(ctx, accountId);
  return { id, accountId, sellerUserId: input.sellerUserId, assignedBy: by, status: 'pending', notes, offerId, ownershipDecision, previousAssignmentId: values.previousAssignmentId };
}

export type BulkAction = ({ kind: 'status' } & StatusChangeInput) | ({ kind: 'assign' } & AssignInput);
export type BulkResult = { accountId: string; ok: true } | { accountId: string; ok: false; status: number; message: string };

/**
 * One action on up to 50 accounts (REV-E1 bulk actions, REV-E2-S1-AC3), each in its own savepoint so one
 * refusal doesn't undo the others. Accounts are taken in id order, so two bulk runs lock rows in the same
 * order. Results come back in the order given.
 */
export async function bulk(ctx: ModuleContext, accountIds: string[], action: BulkAction): Promise<BulkResult[]> {
  requirePerson(ctx);
  const ids = [...new Set(accountIds)];
  if (ids.length === 0 || ids.length > MAX_BULK) throw invalid('Pick 1 to 50 accounts.', 'account_ids');
  const results = new Map<string, BulkResult>();
  const bulkId = newId('blk');
  for (const accountId of [...ids].sort()) {
    try {
      await ctx.tx.transaction(async (tx) => {
        const sp = { ...ctx, tx };
        const { kind, ...input } = action;
        if (kind === 'assign') await assign(sp, accountId, input as AssignInput, { bulkId });
        else await changeStatus(sp, accountId, input as StatusChangeInput);
      });
      results.set(accountId, { accountId, ok: true });
    } catch (e) {
      if (!(e instanceof ScoutError)) throw e;
      results.set(accountId, { accountId, ok: false, status: e.status, message: e.message });
    }
  }
  return ids.map((id) => results.get(id)!);
}
