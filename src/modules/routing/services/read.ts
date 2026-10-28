import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { filterVisibleAccountIds, getAccounts, getSummaries, resolveAccountId } from '@/modules/accounts';
import { accountForArrival } from '@/modules/intake';
import { members, tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { accountReview, assignment, declineReasonDef, statusChange } from '../db/schema';
import { OPEN_STATUSES, loadStatuses, requirePerson } from './review';

export type AccountStatus = {
  accountId: string;
  name: string;
  stage: string;
  reviewStatus: string | null;
  tier: string | null;
  ownerName: string | null;
  /** Null until R1c brings CRM activity. */
  lastActivityAt: Date | null;
  /** The review decline reason's label, only while the account holds a declined status. A seller's decline stays internal. */
  declinedReason: string | null;
  /** The note on the move to a status that returns the account to its source. */
  sendBackNote: string | null;
  summary: string;
};

const monthDay = (d: Date, timeZone: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(d);

/**
 * Where one account stands, for the agent or person that sent it (REV-E4-S2). `idOrArrivalId` may be an
 * `arr_` id, which intake resolves among the caller's own arrivals. An account the caller can't see, or
 * an arrival that isn't theirs, is null (the route answers 404, never 403).
 */
export async function getAccountStatus(ctx: ModuleContext, idOrArrivalId: string): Promise<AccountStatus | null> {
  const asked = idOrArrivalId.startsWith('arr_') ? await accountForArrival(ctx, idOrArrivalId) : idOrArrivalId;
  const accountId = asked ? (await resolveAccountId(ctx, asked))?.id : undefined;
  if (!accountId) return null;
  const [summary] = await getSummaries(ctx, [accountId]);
  const [acc] = await getAccounts(ctx, [accountId]);
  if (!summary || !acc) return null;

  const [review] = await ctx.tx.select().from(accountReview).where(and(eq(accountReview.tenantId, ctx.tenantId), eq(accountReview.accountId, accountId)));
  const status = review ? (await loadStatuses(ctx)).find((s) => s.key === review.statusKey) : undefined;
  const [open] = await ctx.tx
    .select()
    .from(assignment)
    .where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.accountId, accountId), inArray(assignment.status, OPEN_STATUSES)));
  const ownerName = open ? ((await members(ctx)).find((m) => m.userId === open.sellerUserId)?.name ?? null) : null;

  // The latest move to the status the account holds carries its reason and note.
  const [moved] =
    review && (status?.isDeclined || status?.returnsToSource)
      ? await ctx.tx
          .select()
          .from(statusChange)
          .where(and(eq(statusChange.tenantId, ctx.tenantId), eq(statusChange.accountId, accountId), eq(statusChange.toKey, review.statusKey)))
          .orderBy(desc(statusChange.at), desc(statusChange.id))
          .limit(1)
      : [];
  const [reason] =
    moved?.reasonKey && status?.isDeclined
      ? await ctx.tx
          .select({ label: declineReasonDef.label })
          .from(declineReasonDef)
          .where(and(eq(declineReasonDef.tenantId, ctx.tenantId), eq(declineReasonDef.key, moved.reasonKey)))
      : [];
  const declinedReason = reason?.label ?? null;
  const sendBackNote = status?.returnsToSource ? (moved?.note ?? null) : null;

  const timeZone = await tenantTimezone(ctx);
  const summaryText = open
    ? `Assigned to ${ownerName?.split(' ')[0] ?? 'a seller'} on ${monthDay(open.assignedAt, timeZone)}.`
    : status?.isDeclined
      ? declinedReason
        ? `Declined: ${declinedReason}.`
        : 'Declined.'
      : status?.returnsToSource
        ? 'Sent back to the source.'
        : status?.countsAsReviewed
          ? 'Reviewed. Waiting for a seller.'
          : 'Waiting for review.';

  return {
    accountId,
    name: acc.name,
    stage: review?.stage ?? 'arrived',
    reviewStatus: review?.statusKey ?? null,
    tier: summary.tier,
    ownerName,
    lastActivityAt: null,
    declinedReason,
    sendBackNote,
    summary: summaryText,
  };
}

export type AssignmentFilters = {
  /** The actor's own assignments. Needs no visibility of the account (Ruling 17). */
  mine?: boolean;
  status?: string;
  /** Needs the account to be visible to the caller, unless `mine`. */
  accountId?: string;
  cursor?: string;
  limit?: number;
};

export type AssignmentRow = {
  id: string;
  accountId: string;
  accountName: string | null;
  sellerUserId: string;
  sellerName: string | null;
  assignedBy: string;
  assignedAt: Date;
  status: string;
  respondedAt: Date | null;
  /** `seller`, `crm_activity` or `auto_timeout`; null until accepted. */
  acceptedHow: string | null;
  notes: string | null;
  declineReasonKey: string | null;
};

type Key = [string, string];
const encode = (k: Key) => Buffer.from(JSON.stringify(k)).toString('base64url');
function decode(cursor: string): Key {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && !Number.isNaN(Date.parse(v[0]))) return [v[0], v[1]];
  } catch {
    // fall through
  }
  throw new ScoutError({ slug: 'invalid-cursor', status: 400, title: 'Invalid cursor' });
}

/**
 * Assignments, newest first (REV-E2-S2-AC1, AC3). `mine` is the actor's own. Otherwise a row shows when
 * the caller can see its account (or it is theirs), so a seller limited to their own accounts sees only
 * those and a leader sees how each was accepted.
 */
export async function listAssignments(ctx: ModuleContext, f: AssignmentFilters = {}): Promise<{ data: AssignmentRow[]; nextCursor: string | null }> {
  const me = requirePerson(ctx);
  if (f.accountId && !f.mine && (await filterVisibleAccountIds(ctx, [f.accountId])).length === 0) {
    throw new ScoutError({ slug: 'not-found', status: 404, title: 'That account was not found.' });
  }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const size = Math.max(limit + 1, 50);
  let after = f.cursor ? decode(f.cursor) : null;
  const kept: { row: typeof assignment.$inferSelect; key: Key }[] = [];
  for (;;) {
    const rows = await ctx.tx
      .select({ row: assignment, atText: sql<string>`${assignment.assignedAt}::text` })
      .from(assignment)
      .where(
        and(
          eq(assignment.tenantId, ctx.tenantId),
          f.mine ? eq(assignment.sellerUserId, me) : undefined,
          f.status ? eq(assignment.status, f.status) : undefined,
          f.accountId ? eq(assignment.accountId, f.accountId) : undefined,
          after ? sql`(${assignment.assignedAt}, ${assignment.id}) < (${after[0]}::timestamptz, ${after[1]})` : undefined,
        ),
      )
      .orderBy(desc(assignment.assignedAt), desc(assignment.id))
      .limit(size);
    const visible = f.mine ? null : new Set(await filterVisibleAccountIds(ctx, [...new Set(rows.map((r) => r.row.accountId))]));
    for (const r of rows) {
      if (visible && !visible.has(r.row.accountId) && r.row.sellerUserId !== me) continue;
      kept.push({ row: r.row, key: [r.atText, r.row.id] });
      if (kept.length > limit) break;
    }
    if (kept.length > limit || rows.length < size) break;
    after = [rows[rows.length - 1]!.atText, rows[rows.length - 1]!.row.id];
  }
  const page = kept.slice(0, limit);
  const accounts = new Map((await getAccounts(ctx, [...new Set(page.map((p) => p.row.accountId))])).map((a) => [a.id, a.name]));
  const names = new Map((await members(ctx)).map((m) => [m.userId, m.name]));
  return {
    data: page.map(({ row: a }) => ({
      id: a.id,
      accountId: a.accountId,
      accountName: accounts.get(a.accountId) ?? null,
      sellerUserId: a.sellerUserId,
      sellerName: names.get(a.sellerUserId) ?? null,
      assignedBy: a.assignedBy,
      assignedAt: a.assignedAt,
      status: a.status,
      respondedAt: a.respondedAt,
      acceptedHow: a.acceptedHow,
      notes: a.notes,
      declineReasonKey: a.declineReasonKey,
    })),
    nextCursor: kept.length > limit ? encode(page[limit - 1]!.key) : null,
  };
}
