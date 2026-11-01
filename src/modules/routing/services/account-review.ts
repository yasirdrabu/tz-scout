import { and, asc, desc, eq } from 'drizzle-orm';
import { getSummaries } from '@/modules/accounts';
import { sourceNames, sourcesOfAccount } from '@/modules/intake';
import { causeInWords, getScoreHistory, TIER_NAMES, type Tier } from '@/modules/scoring';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import type { ReviewFlags, Stage } from '../contracts/types';
import { assignment, leadOfferChange, stageChange, statusChange } from '../db/schema';
import { EXIT_STAGES, PIPELINE_STAGES, STAGE_LABELS } from '../domain/stages';
import { leadOffer, loadNames } from './lookups';
import { loadStatuses, OPEN_STATUSES, visibleReview } from './review';
import { reasonLabels } from './settings';

export type AccountReviewView = {
  accountId: string;
  status: { key: string; label: string; color: string; setBy: string; changedAt: Date; changedByName: string | null };
  stage: string;
  stageLabel: string;
  stageChangedAt: Date;
  /** One step per pipeline stage with the date it was reached; an exit stage is added when the account holds one. */
  stages: { key: string; label: string; at: Date | null; current: boolean }[];
  insights: { text: string; byName: string | null; at: Date | null } | null;
  flags: Omit<ReviewFlags, 'newFrom'> & { newFrom?: NonNullable<ReviewFlags['newFrom']> & { sourceName: string | null } };
  currentAssignment: {
    id: string;
    sellerUserId: string;
    sellerName: string | null;
    assignedByName: string | null;
    assignedAt: Date;
    notes: string | null;
    status: string;
    acceptedHow: string | null;
    respondedAt: Date | null;
  } | null;
  /** "Approved by {name} on {date}": the latest move to a status that approves the account. */
  approved: { byName: string | null; at: Date } | null;
  /** The source chains the account came through; the owner is who a send back goes to (Decision 11). */
  sources: { sourceId: string; name: string; kind: string; via: string | null; ownerUserId: string | null; ownerName: string | null; batchId: string | null; arrivedAt: Date }[];
  leadOffer: { offerId: string; name: string | null; practiceId: string | null; practiceName: string | null; chosen: boolean } | null;
  bestOfferId: string | null;
  /** `account_review.version`: compare on refetch to see that someone else changed the review. */
  version: number;
};

/** The account's review as the account page and the peek drawer show it. A hidden, missing or merged-away account is a 404. */
export async function getAccountReview(ctx: ModuleContext, accountId: string): Promise<AccountReviewView> {
  const row = await visibleReview(ctx, accountId, { lock: false });
  const statuses = await loadStatuses(ctx);
  const names = await loadNames(ctx);
  const status = statuses.find((s) => s.key === row.statusKey);
  const moves = await ctx.tx
    .select()
    .from(stageChange)
    .where(and(eq(stageChange.tenantId, ctx.tenantId), eq(stageChange.accountId, accountId)))
    .orderBy(asc(stageChange.at), asc(stageChange.id));
  const reached = new Map<string, Date>([['arrived', row.createdAt]]);
  for (const m of moves) reached.set(m.toStage, m.at);
  const stage = row.stage as Stage;
  const steps: string[] = [...PIPELINE_STAGES, ...((EXIT_STAGES as readonly string[]).includes(stage) ? [stage] : [])];
  const [open] = row.currentAssignmentId
    ? await ctx.tx.select().from(assignment).where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.id, row.currentAssignmentId)))
    : [];
  const approvingKeys = new Set(statuses.filter((s) => s.countsAsReviewed && !s.isDeclined && !s.returnsToSource).map((s) => s.key));
  const [approval] = (
    await ctx.tx
      .select({ toKey: statusChange.toKey, by: statusChange.by, at: statusChange.at })
      .from(statusChange)
      .where(and(eq(statusChange.tenantId, ctx.tenantId), eq(statusChange.accountId, accountId)))
      .orderBy(desc(statusChange.at), desc(statusChange.id))
  ).filter((c) => approvingKeys.has(c.toKey));
  const { newFrom, ...flags } = row.flags;
  const newFromName = newFrom ? (await sourceNames(ctx, [newFrom.sourceId])).get(newFrom.sourceId) ?? null : null;
  const [summary] = await getSummaries(ctx, [accountId]);
  return {
    accountId,
    status: {
      key: row.statusKey,
      label: status?.label ?? row.statusKey,
      color: status?.color ?? 'gray',
      setBy: status?.setBy ?? 'reviewer',
      changedAt: row.statusChangedAt,
      changedByName: names.person(row.statusChangedBy),
    },
    stage: row.stage,
    stageLabel: STAGE_LABELS[stage] ?? row.stage,
    stageChangedAt: row.stageChangedAt,
    stages: steps.map((key) => ({ key, label: STAGE_LABELS[key as Stage], at: reached.get(key) ?? null, current: key === row.stage })),
    insights: row.insights ? { text: row.insights, byName: names.person(row.insightsBy), at: row.insightsAt } : null,
    flags: newFrom ? { ...flags, newFrom: { ...newFrom, sourceName: newFromName } } : flags,
    currentAssignment:
      open && OPEN_STATUSES.includes(open.status)
        ? {
            id: open.id,
            sellerUserId: open.sellerUserId,
            sellerName: names.person(open.sellerUserId),
            assignedByName: names.person(open.assignedBy),
            assignedAt: open.assignedAt,
            notes: open.notes,
            status: open.status,
            acceptedHow: open.acceptedHow,
            respondedAt: open.respondedAt,
          }
        : null,
    approved: approval ? { byName: names.person(approval.by), at: approval.at } : null,
    sources: (await sourcesOfAccount(ctx, accountId)).map((s) => ({
      sourceId: s.sourceId,
      name: s.name,
      kind: s.kind,
      via: s.via,
      ownerUserId: s.ownerUserId,
      ownerName: names.person(s.ownerUserId),
      batchId: s.batchId,
      arrivedAt: s.receivedAt,
    })),
    leadOffer: leadOffer(names, row.leadOfferOverrideId, summary?.bestOfferId ?? null),
    bestOfferId: summary?.bestOfferId ?? null,
    version: row.version,
  };
}

export type ChangeKind = 'arrived' | 'status' | 'stage' | 'assigned' | 'accepted' | 'declined_by_seller' | 'withdrawn' | 'scored' | 'tier' | 'lead_offer';

/** One line of the Changes list: "{Field} changed from {x} to {y}" by person and when, and Scout's own lines. */
export type ChangeView = {
  id: string;
  at: Date;
  kind: ChangeKind;
  field: string | null;
  from: string | null;
  to: string | null;
  /** Who did it; null when Scout did. */
  byName: string | null;
  note: string | null;
  reason: string | null;
  /** For `scored`: the priority it was scored, with `to` the tier ("Scored {n} and placed in {tier}"). */
  priority: number | null;
};

type Cursor = [string, string];
const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decode(raw: string): Cursor {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && !Number.isNaN(Date.parse(v[0]))) return [v[0], v[1]];
  } catch {
    // falls through
  }
  throw new ScoutError({ slug: 'invalid-cursor', status: 400, title: 'That cursor is not valid.' });
}

const tierName = (t: string | null) => (t ? (TIER_NAMES[t as Tier] ?? t) : null);
const ACCEPTED_HOW: Record<string, string> = { seller: 'Accepted', crm_activity: 'Accepted automatically after activity in the CRM', auto_timeout: 'Accepted automatically' };

/**
 * The account's change log, newest first (screens.md §3 Changes): status and stage moves, assignments
 * and their answers, Scout's scores, and the first arrival. Paged with a cursor; a hidden account is a 404.
 */
export async function listChanges(ctx: ModuleContext, accountId: string, opts: { cursor?: string; limit?: number } = {}): Promise<{ data: ChangeView[]; nextCursor: string | null }> {
  const limit = opts.limit ?? 50;
  const after = opts.cursor ? decode(opts.cursor) : null;
  const row = await visibleReview(ctx, accountId, { lock: false });
  const names = await loadNames(ctx);
  const statuses = new Map((await loadStatuses(ctx)).map((s) => [s.key, s.label]));
  const statusRows = await ctx.tx.select().from(statusChange).where(and(eq(statusChange.tenantId, ctx.tenantId), eq(statusChange.accountId, accountId)));
  const stageRows = await ctx.tx.select().from(stageChange).where(and(eq(stageChange.tenantId, ctx.tenantId), eq(stageChange.accountId, accountId)));
  const assignments = await ctx.tx.select().from(assignment).where(and(eq(assignment.tenantId, ctx.tenantId), eq(assignment.accountId, accountId)));
  const reasons = await reasonLabels(ctx, [...new Set([...statusRows.map((s) => s.reasonKey), ...assignments.map((a) => a.declineReasonKey)].filter((k): k is string => !!k))]);
  const scores = await getScoreHistory(ctx, accountId, { limit: 50 });
  const offerChanges = await ctx.tx.select().from(leadOfferChange).where(and(eq(leadOfferChange.tenantId, ctx.tenantId), eq(leadOfferChange.accountId, accountId)));
  const [first] = await sourcesOfAccount(ctx, accountId);

  const out: ChangeView[] = [];
  const add = (c: Partial<ChangeView> & Pick<ChangeView, 'id' | 'at' | 'kind'>) =>
    out.push({ field: null, from: null, to: null, byName: null, note: null, reason: null, priority: null, ...c });
  add({ id: first?.arrivalId ?? `arrived:${accountId}`, at: first?.receivedAt ?? row.createdAt, kind: 'arrived', to: first?.name ?? null });
  for (const s of statusRows) {
    add({
      id: s.id,
      at: s.at,
      kind: 'status',
      field: 'review_status',
      from: s.fromKey ? (statuses.get(s.fromKey) ?? s.fromKey) : null,
      to: statuses.get(s.toKey) ?? s.toKey,
      byName: names.person(s.by),
      note: s.note,
      reason: s.reasonKey ? (reasons.get(s.reasonKey) ?? s.reasonKey) : null,
    });
  }
  for (const s of stageRows) add({ id: s.id, at: s.at, kind: 'stage', field: 'stage', from: STAGE_LABELS[s.fromStage as Stage] ?? s.fromStage, to: STAGE_LABELS[s.toStage as Stage] ?? s.toStage });
  for (const a of assignments) {
    add({ id: a.id, at: a.assignedAt, kind: 'assigned', field: 'owner', to: names.person(a.sellerUserId), byName: names.person(a.assignedBy), note: a.notes });
    if (!a.respondedAt) continue;
    if (a.acceptedHow) add({ id: `${a.id}:accepted`, at: a.respondedAt, kind: 'accepted', to: names.person(a.sellerUserId), byName: a.acceptedHow === 'seller' ? names.person(a.sellerUserId) : null, note: ACCEPTED_HOW[a.acceptedHow] ?? null });
    if (a.status === 'declined') {
      add({ id: `${a.id}:declined`, at: a.respondedAt, kind: 'declined_by_seller', byName: names.person(a.sellerUserId), note: a.declineNote, reason: a.declineReasonKey ? (reasons.get(a.declineReasonKey) ?? a.declineReasonKey) : null });
    } else if (a.status === 'withdrawn' || a.status === 'replaced') {
      add({ id: `${a.id}:${a.status}`, at: a.respondedAt, kind: 'withdrawn', from: names.person(a.sellerUserId), note: a.status === 'replaced' ? 'Assigned to someone else' : null });
    }
  }
  for (const s of scores) {
    if (s.cause === 'tier_override') add({ id: s.id, at: s.at, kind: 'tier', field: 'tier', from: tierName(s.fromTier), to: tierName(s.toTier), byName: names.person(s.by), note: s.note });
    else add({ id: s.id, at: s.at, kind: 'scored', field: 'tier', from: tierName(s.fromTier), to: tierName(s.toTier), priority: s.toPriority, note: causeInWords(s.cause) });
  }
  const scoutsPick = "Scout's pick";
  for (const c of offerChanges) {
    add({ id: c.id, at: c.at, kind: 'lead_offer', field: 'best_offer', from: c.fromOfferId ? (names.offer(c.fromOfferId)?.name ?? c.fromOfferId) : scoutsPick, to: c.toOfferId ? (names.offer(c.toOfferId)?.name ?? c.toOfferId) : scoutsPick, byName: names.person(c.by) });
  }

  const sorted = out.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const start = after ? sorted.findIndex((c) => c.at.getTime() < Date.parse(after[0]) || (c.at.getTime() === Date.parse(after[0]) && c.id < after[1])) : 0;
  const rest = start < 0 ? [] : sorted.slice(start);
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return { data: page, nextCursor: rest.length > limit && last ? encode([last.at.toISOString(), last.id]) : null };
}
