import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { filterVisibleAccountIds, getSummaries, isKnownFactKey } from '@/modules/accounts';
import { members } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { arrival, batch } from '../db/schema';
import { feedbackForArrival, type ArrivalFeedback } from './feedback';
import { chainInScope, keysetPage, pageArrivals, visibleArrivals } from './visibility';

type ArrivalRow = typeof arrival.$inferSelect;
type BatchRow = typeof batch.$inferSelect;
type Page<T> = { data: T[]; nextCursor: string | null };

export type ArrivalView = {
  id: string;
  batchId: string | null;
  externalRef: string | null;
  channel: string;
  status: string;
  waitingOn: string | null;
  waitingSince: Date | null;
  reason: string | null;
  detail: string | null;
  accountId: string | null;
  /** True when this arrival's resolution created the account. */
  createdAccount: boolean;
  /** The account it matched, when it attached to an existing one. */
  duplicateOf: string | null;
  duplicateCandidates: unknown;
  sourceChain: { personSourceId?: string; agentSourceId?: string; vendorSourceId?: string };
  receivedAt: Date;
  resolvedAt: Date | null;
};
export type ArrivalDetail = ArrivalView & { payload: unknown; unusedKeys: string[] };

type Candidate = { accountId: string; name: string; domain: string | null; score: number };
const candidatesOf = (r: ArrivalRow): Candidate[] => (r.duplicateCandidates as Candidate[] | null) ?? [];

/** Views of the rows; duplicate candidates keep only the accounts the principal may see. */
export async function toViews(ctx: ModuleContext, rows: ArrivalRow[]): Promise<ArrivalView[]> {
  const ids = [...new Set(rows.flatMap((r) => candidatesOf(r).map((c) => c.accountId)))];
  const visible = new Set(await filterVisibleAccountIds(ctx, ids));
  return rows.map((r) => toView(r, visible));
}

function toView(r: ArrivalRow, visible: Set<string>): ArrivalView {
  return {
    id: r.id,
    batchId: r.batchId,
    externalRef: r.externalRef,
    channel: r.channel,
    status: r.status,
    waitingOn: r.waitingOn,
    waitingSince: r.waitingSince,
    reason: r.rejectReason,
    detail: r.rejectDetail,
    accountId: r.accountId,
    createdAccount: r.resolution === 'created',
    duplicateOf: r.resolution === 'attached' ? r.accountId : null,
    duplicateCandidates: candidatesOf(r).filter((c) => visible.has(c.accountId)),
    sourceChain: {
      ...(r.personSourceId ? { personSourceId: r.personSourceId } : {}),
      ...(r.agentSourceId ? { agentSourceId: r.agentSourceId } : {}),
      ...(r.vendorSourceId ? { vendorSourceId: r.vendorSourceId } : {}),
    },
    receivedAt: r.receivedAt,
    resolvedAt: r.resolvedAt,
  };
}

/** Fact keys the sender used that Scout does not know (SRC-E2-S4-AC1). They stay in the raw payload. */
function unusedKeysOf(r: ArrivalRow): string[] {
  const payload = r.payload as { raw?: unknown; arrival?: unknown };
  const facts = (payload.arrival ?? payload.raw) as { facts?: unknown } | null | undefined;
  const keys = Array.isArray(facts?.facts)
    ? facts.facts.map((f: { key?: unknown }) => f?.key)
    : facts?.facts && typeof facts.facts === 'object'
      ? Object.keys(facts.facts)
      : [];
  return [...new Set(keys.filter((k): k is string => typeof k === 'string' && !isKnownFactKey(k)))];
}

export async function getArrival(ctx: ModuleContext, id: string): Promise<ArrivalDetail | null> {
  const { data } = await pageArrivals(ctx, { where: [eq(arrival.id, id)], limit: 1 });
  const r = data[0];
  return r ? { ...(await toViews(ctx, [r]))[0]!, payload: r.payload, unusedKeys: unusedKeysOf(r) } : null;
}

export type ArrivalWithStatus = ArrivalDetail & {
  /** Where the account stands in review, from Accounts. Null until the account has a summary the principal may see. */
  stage: string | null;
  reviewStatus: string | null;
  /** Null unless the caller may see it (`status:read`). */
  ownerName: string | null;
  /** What the arrival's sources were told about its account (SRC-E1-S4). */
  feedback: ArrivalFeedback[];
};

/**
 * The arrival with its account's stage, review status and owner (Ruling 9: read from Accounts, never
 * from a copy in intake) and the feedback for the principal's source. Null when the arrival is not theirs to see.
 */
export async function getArrivalWithStatus(ctx: ModuleContext, id: string, opts: { ownerName: boolean }): Promise<ArrivalWithStatus | null> {
  const found = await getArrival(ctx, id);
  if (!found) return null;
  const [summary] = found.accountId ? await getSummaries(ctx, [found.accountId]) : [];
  const owner = opts.ownerName && summary?.ownerUserId ? (await members(ctx)).find((m) => m.userId === summary.ownerUserId) : undefined;
  return {
    ...found,
    stage: summary?.stage ?? null,
    reviewStatus: summary?.reviewStatusKey ?? null,
    ownerName: owner?.name ?? null,
    feedback: await feedbackForArrival(ctx, id),
  };
}

export type ArrivalFilter = {
  batchId?: string;
  accountId?: string;
  status?: string;
  since?: Date;
  cursor?: string;
  limit?: number;
};

/** The principal's visible arrivals, newest first. `accountId` lists every arrival that touched the account. */
export async function listArrivals(ctx: ModuleContext, f: ArrivalFilter = {}): Promise<Page<ArrivalView>> {
  const page = await pageArrivals(ctx, {
    where: [
      f.batchId ? eq(arrival.batchId, f.batchId) : undefined,
      f.accountId ? eq(arrival.accountId, f.accountId) : undefined,
      f.status ? eq(arrival.status, f.status) : undefined,
      f.since ? gte(arrival.receivedAt, f.since) : undefined,
    ],
    cursor: f.cursor,
    limit: f.limit,
  });
  return { data: await toViews(ctx, page.data), nextCursor: page.nextCursor };
}

export async function accountForArrival(ctx: ModuleContext, arrivalId: string): Promise<string | null> {
  const { data } = await pageArrivals(ctx, { where: [eq(arrival.id, arrivalId)], limit: 1 });
  return data[0]?.accountId ?? null;
}

/**
 * The accounts a batch's items resolved to, at most 1,000, for the review queue's batch filter. Not
 * narrowed by visibility: the caller passes them to accounts `search`, which applies the data limits.
 */
export async function batchAccountIds(ctx: ModuleContext, batchId: string): Promise<string[]> {
  const rows = await ctx.tx
    .selectDistinct({ accountId: arrival.accountId })
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.batchId, batchId), isNotNull(arrival.accountId)))
    .orderBy(arrival.accountId)
    .limit(1000);
  return rows.map((r) => r.accountId!);
}

// ---- Batches ----

/** A rejected item keeps no `external_ref` column (it could repeat), so the sender's ref is read from what they sent. */
function rawRefOf(payload: unknown): string | null {
  const raw = (payload as { raw?: { external_ref?: unknown; account?: { external_ref?: unknown } } } | null)?.raw;
  const ref = raw?.account?.external_ref ?? raw?.external_ref;
  return typeof ref === 'string' ? ref : null;
}

export type BatchView = {
  id: string;
  name: string;
  runAt: Date;
  status: string;
  completedAt: Date | null;
  itemCount: number;
  counts: { resolved: number; rejected: number; newAccounts: number; alreadyKnown: number };
  sourceChain: ArrivalView['sourceChain'];
};
export type BatchDetail = BatchView & {
  /** Items by stage; `waiting` items are the ones a person must act on. */
  stages: { received: number; resolving: number; waiting: number; resolved: number; rejected: number };
  /** Resolved items by the stage of their account (SRC-E2-S3-AC1). Items whose account the principal can't see are left out. */
  countsByStage: Record<string, number>;
  rejections: { arrivalId: string; externalRef: string | null; reason: string | null; detail: string | null }[];
};

function batchView(b: BatchRow): BatchView {
  const c = b.counts as Partial<BatchView['counts']>;
  return {
    id: b.id,
    name: b.name,
    runAt: b.runAt,
    status: b.status,
    completedAt: b.completedAt,
    itemCount: b.itemCount,
    counts: { resolved: c.resolved ?? 0, rejected: c.rejected ?? 0, newAccounts: c.newAccounts ?? 0, alreadyKnown: c.alreadyKnown ?? 0 },
    sourceChain: {
      ...(b.personSourceId ? { personSourceId: b.personSourceId } : {}),
      ...(b.agentSourceId ? { agentSourceId: b.agentSourceId } : {}),
      ...(b.vendorSourceId ? { vendorSourceId: b.vendorSourceId } : {}),
    },
  };
}

type BatchCandidate = { row: BatchRow; chainOk: boolean };

/** Batches whose chain the principal may see, or which hold an arrival whose account they may see. */
async function visibleBatches(ctx: ModuleContext, rows: BatchCandidate[]): Promise<BatchCandidate[]> {
  const scope = await visibleArrivals(ctx);
  const out: BatchCandidate[] = [];
  for (const r of rows) {
    if (r.chainOk) out.push(r);
    else if (scope.viaAccounts && (await pageArrivals(ctx, { where: [eq(arrival.batchId, r.row.id)], limit: 1 })).data.length > 0) out.push(r);
  }
  return out;
}

async function pageBatches(ctx: ModuleContext, o: { id?: string; cursor?: string; limit?: number }): Promise<Page<BatchCandidate>> {
  const scope = await visibleArrivals(ctx);
  const chain = chainInScope(scope, { person: batch.personSourceId, agent: batch.agentSourceId, vendor: batch.vendorSourceId });
  const page = await keysetPage<BatchCandidate>({
    cursor: o.cursor,
    limit: o.limit,
    fetch: async (after, size) => {
      const rows = await ctx.tx
        .select({ row: batch, atText: sql<string>`${batch.runAt}::text`, chainOk: sql<boolean>`${chain}` })
        .from(batch)
        .where(
          and(
            eq(batch.tenantId, ctx.tenantId),
            o.id ? eq(batch.id, o.id) : undefined,
            scope.viaAccounts ? undefined : chain,
            after ? sql`(${batch.runAt}, ${batch.id}) < (${after[0]}::timestamptz, ${after[1]})` : undefined,
          ),
        )
        .orderBy(desc(batch.runAt), desc(batch.id))
        .limit(size);
      return rows.map((r) => ({ item: { row: r.row, chainOk: r.chainOk }, key: [r.atText, r.row.id] as [string, string] }));
    },
    keep: (items) => visibleBatches(ctx, items),
  });
  return page;
}

/**
 * A batch seen only through account visibility shows just the items the principal may see: its item
 * count, counts and stages are rebuilt from those rows, so nothing reveals the hidden ones.
 */
async function visibleItems(ctx: ModuleContext, batchId: string): Promise<ArrivalRow[]> {
  const rows: ArrivalRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await pageArrivals(ctx, { where: [eq(arrival.batchId, batchId)], cursor, limit: 200 });
    rows.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

function narrowed(b: BatchRow, rows: ArrivalRow[]): BatchView {
  const counts = { resolved: 0, rejected: 0, newAccounts: 0, alreadyKnown: 0 };
  for (const r of rows) {
    if (r.status === 'rejected') counts.rejected++;
    else if (r.status === 'resolved') {
      counts.resolved++;
      counts[r.resolution === 'created' ? 'newAccounts' : 'alreadyKnown']++;
    }
  }
  // Status follows the visible items only, so an open hidden item can't be inferred from it.
  const open = rows.some((r) => r.status === 'received' || r.status === 'resolving');
  const doneAt = rows.map((r) => r.resolvedAt?.getTime()).filter((t): t is number => t !== undefined);
  return {
    ...batchView(b),
    itemCount: rows.length,
    counts,
    status: open ? 'processing' : 'completed',
    completedAt: open || doneAt.length === 0 ? null : new Date(Math.max(...doneAt)),
  };
}

export async function listBatches(ctx: ModuleContext, f: { cursor?: string; limit?: number } = {}): Promise<Page<BatchView>> {
  const page = await pageBatches(ctx, f);
  const data: BatchView[] = [];
  for (const c of page.data) data.push(c.chainOk ? batchView(c.row) : narrowed(c.row, await visibleItems(ctx, c.row.id)));
  return { data, nextCursor: page.nextCursor };
}

const rejectionOf = (r: { id: string; externalRef: string | null; payload: unknown; rejectReason: string | null; rejectDetail: string | null }) => ({
  arrivalId: r.id,
  externalRef: r.externalRef ?? rawRefOf(r.payload),
  reason: r.rejectReason,
  detail: r.rejectDetail,
});

/** Resolved items by account stage. `items` maps each account to how many of the batch's items resolved to it. */
async function stageCounts(ctx: ModuleContext, items: Map<string, number>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const ids = [...items.keys()];
  for (let i = 0; i < ids.length; i += 1000) {
    for (const s of await getSummaries(ctx, ids.slice(i, i + 1000))) {
      if (s.stage) out[s.stage] = (out[s.stage] ?? 0) + (items.get(s.accountId) ?? 0);
    }
  }
  return out;
}

/**
 * SRC-E2-S3-AC1: counts, counts by stage and the rejections. Null when the batch is hidden (SRC-E2-S3-AC3).
 * Seen only through account visibility, everything (item count included) covers just the visible items.
 */
export async function getBatch(ctx: ModuleContext, id: string): Promise<BatchDetail | null> {
  const found = (await pageBatches(ctx, { id, limit: 1 })).data[0];
  if (!found) return null;
  const stages = { received: 0, resolving: 0, waiting: 0, resolved: 0, rejected: 0 };
  if (!found.chainOk) {
    const rows = await visibleItems(ctx, id);
    const accounts = new Map<string, number>();
    for (const r of rows) {
      stages[r.status === 'resolving' && r.waitingOn ? 'waiting' : (r.status as keyof typeof stages)]++;
      if (r.status === 'resolved' && r.accountId) accounts.set(r.accountId, (accounts.get(r.accountId) ?? 0) + 1);
    }
    return {
      ...narrowed(found.row, rows),
      stages,
      countsByStage: await stageCounts(ctx, accounts),
      rejections: rows.filter((r) => r.status === 'rejected').reverse().map((r) => rejectionOf({ ...r, id: r.id })),
    };
  }
  const grouped = await ctx.tx
    .select({ status: arrival.status, waiting: sql<boolean>`${arrival.waitingOn} is not null`, n: sql<number>`count(*)::int` })
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.batchId, id)))
    .groupBy(arrival.status, sql`${arrival.waitingOn} is not null`);
  for (const g of grouped) stages[g.status === 'resolving' && g.waiting ? 'waiting' : (g.status as keyof typeof stages)] += g.n;
  const resolved = await ctx.tx
    .select({ accountId: arrival.accountId, n: sql<number>`count(*)::int` })
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.batchId, id), eq(arrival.status, 'resolved'), isNotNull(arrival.accountId)))
    .groupBy(arrival.accountId);
  const countsByStage = await stageCounts(ctx, new Map(resolved.map((r) => [r.accountId!, r.n])));
  const rejected = await ctx.tx
    .select({ id: arrival.id, externalRef: arrival.externalRef, payload: arrival.payload, rejectReason: arrival.rejectReason, rejectDetail: arrival.rejectDetail })
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.batchId, id), eq(arrival.status, 'rejected')))
    .orderBy(arrival.receivedAt, arrival.id);
  return { ...batchView(found.row), stages, countsByStage, rejections: rejected.map(rejectionOf) };
}

/** Every item of a batch the principal may see, newest first. Null when the batch is hidden. */
export async function listBatchItems(
  ctx: ModuleContext,
  batchId: string,
  f: { cursor?: string; limit?: number } = {},
): Promise<Page<ArrivalView> | null> {
  if (!(await pageBatches(ctx, { id: batchId, limit: 1 })).data[0]) return null;
  return listArrivals(ctx, { batchId, ...f });
}
