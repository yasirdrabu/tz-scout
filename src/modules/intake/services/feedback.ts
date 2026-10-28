import type { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { filterVisibleAccountIds } from '@/modules/accounts';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { feedbackRecorded } from '../contracts/events';
import { arrival, sourceFeedback } from '../db/schema';
import { childSources } from './sources';
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
 * SRC-E1-S4-AC1: one row for every source in the chain of every resolved arrival of the account, and
 * `intake.feedback.recorded` for each new row. The unique (source, arrival, kind, cause event) makes a
 * replay add and publish nothing. Returns how many rows were new.
 */
export async function recordFeedback(
  ctx: ModuleContext,
  f: { accountId: string; kind: FeedbackKind; reasonKey: string | null; note: string | null; causeEventId: string },
): Promise<number> {
  const arrivals = await ctx.tx
    .select({ id: arrival.id, person: arrival.personSourceId, agent: arrival.agentSourceId, vendor: arrival.vendorSourceId })
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.accountId, f.accountId), eq(arrival.status, 'resolved')))
    .orderBy(asc(arrival.id));
  const values = arrivals.flatMap((a) =>
    [...new Set([a.person, a.agent, a.vendor].filter((s): s is string => !!s))].map((sourceId) => ({
      id: newId('fb'),
      tenantId: ctx.tenantId,
      sourceId,
      arrivalId: a.id,
      accountId: f.accountId,
      kind: f.kind,
      reasonKey: f.reasonKey,
      note: f.note,
      causeEventId: f.causeEventId,
    })),
  );
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
async function ownSources(ctx: ModuleContext): Promise<string[] | null> {
  const access = ctx.access;
  if (!access) return null;
  if (!access.sourceId) return [];
  return [...new Set([access.sourceId, ...(access.childSourceIds ?? []), ...(await childSources(ctx, [access.sourceId]))])];
}

/** Feedback on one arrival, for the principal's own source only (SRC-E1-S4-AC2). Oldest first. */
export async function feedbackForArrival(ctx: ModuleContext, arrivalId: string): Promise<FeedbackView[]> {
  const own = await ownSources(ctx);
  if (own?.length === 0) return [];
  const rows = await ctx.tx
    .select()
    .from(sourceFeedback)
    .where(
      and(
        eq(sourceFeedback.tenantId, ctx.tenantId),
        eq(sourceFeedback.arrivalId, arrivalId),
        own ? inArray(sourceFeedback.sourceId, own) : undefined,
      ),
    )
    .orderBy(asc(sourceFeedback.createdAt), asc(sourceFeedback.id));
  return rows.map(view);
}

/**
 * The feed (`GET /v1/feedback`): feedback for the principal's own source and its children, newest
 * first. A row is also held back when its account is outside the principal's data limit.
 */
export async function listFeedback(
  ctx: ModuleContext,
  f: { since?: Date; cursor?: string; limit?: number } = {},
): Promise<{ data: FeedbackView[]; nextCursor: string | null }> {
  const own = await ownSources(ctx);
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
