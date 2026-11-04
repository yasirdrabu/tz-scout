import type { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { filterVisibleAccountIds } from '@/modules/accounts';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { feedbackRecorded } from '../contracts/events';
import { arrival, sourceFeedback } from '../db/schema';
import { keysetPage, visibleArrivals } from './visibility';

type FeedbackRow = typeof sourceFeedback.$inferSelect;
export type FeedbackKind = z.infer<typeof feedbackRecorded.data>['kind'];

export type FeedbackView = {
  id: string;
  sourceId: string;
  /** Null when the source had no resolved arrival for the account (Ruling 10, R2b-2). */
  arrivalId: string | null;
  accountId: string;
  kind: string;
  reasonKey: string | null;
  note: string | null;
  byUserId: string | null;
  createdAt: Date;
};

const view = (r: FeedbackRow): FeedbackView => ({
  id: r.id,
  sourceId: r.sourceId,
  arrivalId: r.arrivalId,
  accountId: r.accountId,
  kind: r.kind,
  reasonKey: r.reasonKey,
  note: r.note,
  byUserId: r.byUserId,
  createdAt: r.createdAt,
});

const WRITE_CHUNK = 500;

/**
 * SRC-E1-S4-AC1: one row for every distinct source in the chains of the account's resolved arrivals,
 * pinned to that source's most recent resolved arrival, and `intake.feedback.recorded` for each new
 * row. The unique (source, kind, cause event) makes a replay add and publish nothing, even if a newer
 * arrival appeared in between. Returns how many rows were new.
 */
export async function recordFeedback(
  ctx: ModuleContext,
  f: { accountId: string; kind: FeedbackKind; reasonKey: string | null; note: string | null; byUserId?: string | null; causeEventId: string },
): Promise<number> {
  const arrivals = await ctx.tx
    .select({ id: arrival.id, person: arrival.personSourceId, agent: arrival.agentSourceId, vendor: arrival.vendorSourceId })
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.accountId, f.accountId), eq(arrival.status, 'resolved')))
    .orderBy(asc(arrival.receivedAt), asc(arrival.id));
  const latest = new Map<string, string>();
  for (const a of arrivals) for (const sourceId of [a.person, a.agent, a.vendor]) if (sourceId) latest.set(sourceId, a.id);
  return writeFeedback(ctx, f, latest);
}

/**
 * Ruling 8 (R2a): a person kept another source's value, so each losing source is told on the arrival its losing
 * fact came with, with the winner's source name as the note. A source in the chain of a losing arrival that is
 * not in `losingSourceIds` (it is also in the winner's chain) is not told. Idempotent per cause event.
 */
export async function recordConflictLost(
  ctx: ModuleContext,
  f: { accountId: string; factArrivalIds: string[]; losingSourceIds: string[]; winnerSourceName: string | null; byUserId?: string | null; causeEventId: string },
): Promise<number> {
  if (f.factArrivalIds.length === 0 || f.losingSourceIds.length === 0) return 0;
  const arrivals = await ctx.tx
    .select({ id: arrival.id, person: arrival.personSourceId, agent: arrival.agentSourceId, vendor: arrival.vendorSourceId })
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), inArray(arrival.id, f.factArrivalIds)))
    .orderBy(asc(arrival.receivedAt), asc(arrival.id));
  const losing = new Set(f.losingSourceIds);
  const bySource = new Map<string, string>();
  for (const a of arrivals) for (const sourceId of [a.person, a.agent, a.vendor]) if (sourceId && losing.has(sourceId)) bySource.set(sourceId, a.id);
  return writeFeedback(ctx, { ...f, kind: 'conflict_lost', reasonKey: null, note: f.winnerSourceName }, bySource);
}

/**
 * R2b-2 Ruling 10: one source is told, such as the source that asked for an enrichment a leader declined, and not the
 * rest of its chain. The row is pinned to that source's latest resolved arrival for the account, or to none when it
 * has none (an agent asking about an account it never sent). Idempotent per (source, kind, cause event).
 */
export async function recordSourceFeedback(
  ctx: ModuleContext,
  f: { sourceId: string; accountId: string; kind: FeedbackKind; note: string | null; byUserId?: string | null; causeEventId: string },
): Promise<number> {
  const [latest] = await ctx.tx
    .select({ id: arrival.id })
    .from(arrival)
    .where(
      and(
        eq(arrival.tenantId, ctx.tenantId),
        eq(arrival.accountId, f.accountId),
        eq(arrival.status, 'resolved'),
        or(eq(arrival.personSourceId, f.sourceId), eq(arrival.agentSourceId, f.sourceId), eq(arrival.vendorSourceId, f.sourceId)),
      ),
    )
    .orderBy(desc(arrival.receivedAt), desc(arrival.id))
    .limit(1);
  return writeFeedback(ctx, { ...f, reasonKey: null }, new Map([[f.sourceId, latest?.id ?? null]]));
}

/** One row per (source, arrival) and `intake.feedback.recorded` for each new one; returns how many were new. */
async function writeFeedback(
  ctx: ModuleContext,
  f: { accountId: string; kind: FeedbackKind; reasonKey: string | null; note: string | null; byUserId?: string | null; causeEventId: string },
  arrivalBySource: Map<string, string | null>,
): Promise<number> {
  const values = [...arrivalBySource].map(([sourceId, arrivalId]) => ({
    id: newId('fb'),
    tenantId: ctx.tenantId,
    sourceId,
    arrivalId,
    accountId: f.accountId,
    kind: f.kind,
    reasonKey: f.reasonKey,
    note: f.note,
    byUserId: f.byUserId ?? null,
    causeEventId: f.causeEventId,
  }));
  let added = 0;
  for (let i = 0; i < values.length; i += WRITE_CHUNK) {
    const inserted = await ctx.tx.insert(sourceFeedback).values(values.slice(i, i + WRITE_CHUNK)).onConflictDoNothing().returning();
    for (const r of inserted) {
      await publish(
        ctx,
        feedbackRecorded,
        { sourceId: r.sourceId, arrivalId: r.arrivalId, accountId: r.accountId, kind: f.kind, reasonKey: r.reasonKey, note: r.note },
        r.arrivalId ? { type: 'arrival', id: r.arrivalId } : { type: 'source', id: r.sourceId },
      );
    }
    added += inserted.length;
  }
  return added;
}

/** The principal's own source and every source below it. Null means no limit (a worker context); empty means no source. */
function ownSources(ctx: ModuleContext): string[] | null {
  const access = ctx.access;
  if (!access) return null;
  return access.sourceId ? [access.sourceId, ...(access.childSourceIds ?? [])] : [];
}

export type ArrivalFeedback = { kind: string; reasonKey: string | null; note: string | null; at: Date };

/**
 * What the arrival's sources were told about its account (SRC-E1-S4): rows for the account whose source is
 * in the arrival's chain, one entry per cause event, oldest first. The caller has already checked that
 * the principal may see the arrival.
 */
export async function feedbackForArrival(ctx: ModuleContext, arrivalId: string): Promise<ArrivalFeedback[]> {
  const [a] = await ctx.tx
    .select({ accountId: arrival.accountId, person: arrival.personSourceId, agent: arrival.agentSourceId, vendor: arrival.vendorSourceId })
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.id, arrivalId)));
  const chain = [a?.person, a?.agent, a?.vendor].filter((s): s is string => !!s);
  if (!a?.accountId || chain.length === 0) return [];
  const rows = await ctx.tx
    .select()
    .from(sourceFeedback)
    .where(and(eq(sourceFeedback.tenantId, ctx.tenantId), eq(sourceFeedback.accountId, a.accountId), inArray(sourceFeedback.sourceId, chain)))
    .orderBy(asc(sourceFeedback.createdAt), asc(sourceFeedback.id));
  const byCause = new Map<string, FeedbackRow>();
  for (const r of rows) if (!byCause.has(r.kind + r.causeEventId)) byCause.set(r.kind + r.causeEventId, r);
  return [...byCause.values()].map((r) => ({ kind: r.kind, reasonKey: r.reasonKey, note: r.note, at: r.createdAt }));
}

/**
 * The feed (`GET /api/v1/feedback`): feedback for the principal's own source and its children, newest
 * first, or for `sourceIds` when the caller (a Source page) names them. A row is also held back when its account is
 * outside the principal's data limit.
 */
export async function listFeedback(
  ctx: ModuleContext,
  f: { since?: Date; cursor?: string; limit?: number; sourceIds?: string[] } = {},
): Promise<{ data: FeedbackView[]; nextCursor: string | null }> {
  const own = f.sourceIds ?? ownSources(ctx);
  if (own?.length === 0) return { data: [], nextCursor: null };
  const scope = await visibleArrivals(ctx);
  const inChain = new Set(scope.sourceIds);
  return keysetPage<FeedbackRow>({
    cursor: f.cursor,
    limit: f.limit,
    fetch: async (after, size) => {
      const rows = await ctx.tx
        .select({ row: sourceFeedback, atText: sql<string>`${sourceFeedback.createdAt}::text` })
        .from(sourceFeedback)
        .where(
          and(
            eq(sourceFeedback.tenantId, ctx.tenantId),
            own ? inArray(sourceFeedback.sourceId, own) : undefined,
            f.since ? gte(sourceFeedback.createdAt, f.since) : undefined,
            after ? sql`(${sourceFeedback.createdAt}, ${sourceFeedback.id}) < (${after[0]}::timestamptz, ${after[1]})` : undefined,
          ),
        )
        .orderBy(desc(sourceFeedback.createdAt), desc(sourceFeedback.id))
        .limit(size);
      return rows.map((r) => ({ item: r.row, key: [r.atText, r.row.id] as [string, string] }));
    },
    keep: async (rows) => {
      if (scope.all) return rows;
      const open = rows.filter((r) => !inChain.has(r.sourceId));
      const seen = new Set(scope.viaAccounts ? await filterVisibleAccountIds(ctx, [...new Set(open.map((r) => r.accountId))]) : []);
      return rows.filter((r) => inChain.has(r.sourceId) || seen.has(r.accountId));
    },
  }).then((p) => ({ data: p.data.map(view), nextCursor: p.nextCursor }));
}
