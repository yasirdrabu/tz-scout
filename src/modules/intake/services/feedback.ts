import type { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
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
  arrivalId: string;
  accountId: string;
  kind: string;
  reasonKey: string | null;
  note: string | null;
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
  f: { accountId: string; kind: FeedbackKind; reasonKey: string | null; note: string | null; causeEventId: string },
): Promise<number> {
  const arrivals = await ctx.tx
    .select({ id: arrival.id, person: arrival.personSourceId, agent: arrival.agentSourceId, vendor: arrival.vendorSourceId })
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.accountId, f.accountId), eq(arrival.status, 'resolved')))
    .orderBy(asc(arrival.receivedAt), asc(arrival.id));
  const latest = new Map<string, string>();
  for (const a of arrivals) for (const sourceId of [a.person, a.agent, a.vendor]) if (sourceId) latest.set(sourceId, a.id);
  const values = [...latest].map(([sourceId, arrivalId]) => ({
    id: newId('fb'),
    tenantId: ctx.tenantId,
    sourceId,
    arrivalId,
    accountId: f.accountId,
    kind: f.kind,
    reasonKey: f.reasonKey,
    note: f.note,
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
        { type: 'arrival', id: r.arrivalId },
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
 * The feed (`GET /v1/feedback`): feedback for the principal's own source and its children, newest
 * first. A row is also held back when its account is outside the principal's data limit.
 */
export async function listFeedback(
  ctx: ModuleContext,
  f: { since?: Date; cursor?: string; limit?: number } = {},
): Promise<{ data: FeedbackView[]; nextCursor: string | null }> {
  const own = ownSources(ctx);
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
