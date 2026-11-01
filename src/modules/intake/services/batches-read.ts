import { and, eq, inArray, isNotNull, sql, type SQLWrapper } from 'drizzle-orm';
import { accountNames, getSummaries } from '@/modules/accounts';
import { apiKeyNames, userNames } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { sha256 } from '@/platform/idempotency';
import { moveItemFields } from '../contracts/arrival';
import { arrival, batch, batchFile, fileImport, source } from '../db/schema';
import {
  BATCH_STATUS_KEYS,
  BATCH_STATUS_LABELS,
  REJECT_REASON_LABELS,
  batchStatus,
  itemOutcome,
  progressLabel,
  type BatchStatusKey,
  type ItemOutcome,
  type Stages,
} from '../domain/batch-status';
import { readFile, type StoredFile } from './files';
import {
  batchView,
  batchWhere,
  getBatch,
  narrowed,
  notSuperseded,
  pageBatches,
  toViews,
  visibleRowsOfBatches,
  type BatchArrival,
  type BatchCandidate,
  type BatchDetail,
  type BatchFilters,
  type BatchView,
} from './status';
import { chainInScope, countArrivals, pageArrivals, visibleArrivals } from './visibility';

// The batch screens' reads (§13, §14): derived status, issue and progress (Ruling 8), items with their outcome (Ruling 9),
// the original files and the rejected rows.

type BatchRow = typeof batch.$inferSelect;
type ArrivalRow = typeof arrival.$inferSelect;
type ImportRow = Pick<typeof fileImport.$inferSelect, 'id' | 'batchId' | 'status' | 'stats' | 'rowCount'>;

/** What `runImport` keeps in `file_import.stats` that these reads use. */
type RunStats = { cursor?: number; companies?: number; error?: string; stopped?: string };

export type SentBy = { kind: 'user' | 'api_key' | 'system'; id: string; name: string };
export type BatchFileRef = { id: string; fileName: string; sizeBytes: number; contentType: string; sha256: string; createdAt: Date };

export type BatchRowView = BatchView & {
  notes: string | null;
  statusKey: BatchStatusKey;
  statusLabel: string;
  issue: string | null;
  stages: Stages;
  progressLabel: string;
  source: { id: string; name: string; kind: string } | null;
  sentBy: SentBy;
  files: BatchFileRef[];
  import: { id: string; status: string; error: string | null } | null;
  retryable: number;
};

/** A file's id on the wire: stable, and not the storage key. */
export const fileIdOf = (storageKey: string): string => `fil_${sha256(storageKey).slice(0, 26)}`;

const emptyStages = (): Stages => ({ received: 0, resolving: 0, waiting: 0, resolved: 0, rejected: 0 });
const stageOf = (status: string, waiting: boolean): keyof Stages => (status === 'resolving' && waiting ? 'waiting' : (status as keyof Stages));

type Facts = { stages: Stages; capRejected: number; imp: ImportRow | null };

/** Rows an import left when it stopped because its source was paused (Ruling 8). */
function leftByPause(imp: ImportRow | null): number {
  if (!imp || imp.status !== 'failed') return 0;
  const stats = (imp.stats ?? {}) as RunStats;
  if (stats.stopped !== 'paused') return 0;
  return Math.max(0, (stats.companies ?? imp.rowCount ?? 0) - (stats.cursor ?? 0));
}

type Ids = string[] | SQLWrapper;
const none = (ids: Ids) => Array.isArray(ids) && ids.length === 0;
const factsFor = (out: Map<string, Facts>, id: string): Facts => {
  let f = out.get(id);
  if (!f) out.set(id, (f = { stages: emptyStages(), capRejected: 0, imp: null }));
  return f;
};

/** Stages and retryable rejections of chain-visible batches, from every row: one grouped read for the whole set. */
async function chainFacts(ctx: ModuleContext, ids: Ids, out: Map<string, Facts>): Promise<void> {
  if (none(ids)) return;
  const waiting = sql<boolean>`${arrival.waitingOn} is not null`;
  const cap = sql<boolean>`coalesce(${arrival.rejectReason} = 'daily_cap_reached', false)`;
  const grouped = await ctx.tx
    .select({ batchId: arrival.batchId, status: arrival.status, waiting, cap, n: sql<number>`count(*)::int` })
    .from(arrival)
    .where(and(eq(arrival.tenantId, ctx.tenantId), inArray(arrival.batchId, ids), notSuperseded))
    .groupBy(arrival.batchId, arrival.status, waiting, cap);
  for (const g of grouped) {
    const f = factsFor(out, g.batchId!);
    f.stages[stageOf(g.status, g.waiting)] += g.n;
    if (g.status === 'rejected' && g.cap) f.capRejected += g.n;
  }
}

/** Stages and retryable rejections of batches seen through account visibility, from their visible rows only. */
function rowFacts(rows: Map<string, BatchArrival[]>, out: Map<string, Facts>): void {
  for (const [id, list] of rows) {
    const f = factsFor(out, id);
    for (const a of list) {
      f.stages[stageOf(a.status, a.waitingOn !== null)]++;
      if (a.status === 'rejected' && a.rejectReason === 'daily_cap_reached') f.capRejected++;
    }
  }
}

/** The import of each batch in the set: one read. */
async function importFacts(ctx: ModuleContext, ids: Ids, out: Map<string, Facts>): Promise<void> {
  if (none(ids)) return;
  const imports = await ctx.tx
    .select({ id: fileImport.id, batchId: fileImport.batchId, status: fileImport.status, stats: fileImport.stats, rowCount: fileImport.rowCount })
    .from(fileImport)
    .where(and(eq(fileImport.tenantId, ctx.tenantId), inArray(fileImport.batchId, ids)))
    .orderBy(fileImport.createdAt);
  for (const i of imports) factsFor(out, i.batchId!).imp = i;
}

/** The visible rows of the candidates seen only through account visibility, in one read. */
const rowsOfOthers = (ctx: ModuleContext, rows: BatchCandidate[]) => visibleRowsOfBatches(ctx, rows.filter((r) => !r.chainOk).map((r) => r.row.id));

/** Stages, retryable rejections and the import of each batch: from every row for a chain-visible batch, else from the visible rows. */
async function factsOf(ctx: ModuleContext, rows: BatchCandidate[], others: Map<string, BatchArrival[]>): Promise<Map<string, Facts>> {
  const out = new Map<string, Facts>();
  for (const r of rows) factsFor(out, r.row.id);
  await chainFacts(ctx, rows.filter((r) => r.chainOk).map((r) => r.row.id), out);
  rowFacts(others, out);
  await importFacts(ctx, rows.map((r) => r.row.id), out);
  return out;
}

type Light = { id: string; statusKey: BatchStatusKey; issue: string | null };

function statusOf(f: Facts, stored: string) {
  const stats = (f.imp?.stats ?? {}) as RunStats;
  const retryable = f.capRejected + leftByPause(f.imp);
  const s = batchStatus({
    stored,
    importStatus: f.imp?.status ?? null,
    importError: stats.error ?? null,
    received: f.stages.received,
    resolving: f.stages.resolving,
    waiting: f.stages.waiting,
    capRejected: f.capRejected,
    retryable,
  });
  return { ...s, retryable };
}

/** A batch seen through account visibility has a stored status from its visible rows only. */
const narrowedStatus = (f: Facts) => (f.stages.received + f.stages.resolving > 0 ? 'processing' : 'completed');

function lightOf(id: string, f: Facts, stored: string): Light {
  const s = statusOf(f, stored);
  return { id, statusKey: s.key, issue: s.issue };
}

/** The status of each candidate, without names or files: for the status filter. */
async function lightViews(ctx: ModuleContext, rows: BatchCandidate[]): Promise<Light[]> {
  const facts = await factsOf(ctx, rows, await rowsOfOthers(ctx, rows));
  return rows.map((r) => {
    const f = facts.get(r.row.id)!;
    return lightOf(r.row.id, f, r.chainOk ? r.row.status : narrowedStatus(f));
  });
}

const closestOf = (b: BatchRow) => b.agentSourceId ?? b.personSourceId ?? b.vendorSourceId;

function parsePrincipal(principal: string): { kind: SentBy['kind']; id: string } {
  const [kind, ...rest] = principal.split(':');
  const id = rest.join(':');
  return { kind: kind === 'user' ? 'user' : kind === 'agent' ? 'api_key' : 'system', id };
}

/**
 * The full rows: status, stages, source, sender, files and import. A batch seen only through account visibility
 * lists no files: the original upload holds every row, the hidden ones too.
 */
async function fullViews(ctx: ModuleContext, rows: BatchCandidate[], given?: Map<string, BatchView>): Promise<BatchRowView[]> {
  if (rows.length === 0) return [];
  const others = await rowsOfOthers(ctx, rows);
  const facts = await factsOf(ctx, rows, others);
  const base = given ?? new Map(rows.map((r) => [r.row.id, r.chainOk ? batchView(r.row) : narrowed(r.row, others.get(r.row.id) ?? [])]));
  const chainIds = rows.filter((r) => r.chainOk).map((r) => r.row.id);
  const files = chainIds.length
    ? await ctx.tx
        .select({
          batchId: batchFile.batchId,
          storageKey: batchFile.storageKey,
          fileName: batchFile.fileName,
          sizeBytes: batchFile.sizeBytes,
          contentType: batchFile.contentType,
          sha256: batchFile.sha256,
          createdAt: batchFile.createdAt,
        })
        .from(batchFile)
        .where(and(eq(batchFile.tenantId, ctx.tenantId), inArray(batchFile.batchId, chainIds)))
        .orderBy(batchFile.createdAt, batchFile.storageKey)
    : [];
  const sourceIds = [...new Set(rows.map((r) => closestOf(r.row)).filter((x): x is string => !!x))];
  const sources = sourceIds.length
    ? await ctx.tx
        .select({ id: source.id, name: source.name, kind: source.kind })
        .from(source)
        .where(and(eq(source.tenantId, ctx.tenantId), inArray(source.id, sourceIds)))
    : [];
  const senders = rows.map((r) => parsePrincipal(r.row.principal));
  const users = await userNames(ctx, senders.filter((s) => s.kind === 'user').map((s) => s.id));
  const keys = await apiKeyNames(ctx, senders.filter((s) => s.kind === 'api_key').map((s) => s.id));

  return rows.map((r, i) => {
    const b = r.row;
    const f = facts.get(b.id)!;
    const view = base.get(b.id)!;
    const s = statusOf(f, view.status);
    const sender = senders[i]!;
    const closest = closestOf(b);
    const stats = (f.imp?.stats ?? {}) as RunStats;
    return {
      ...view,
      notes: b.notes,
      statusKey: s.key,
      statusLabel: s.label,
      issue: s.issue,
      stages: f.stages,
      progressLabel: progressLabel(f.stages),
      source: sources.find((x) => x.id === closest) ?? null,
      sentBy: {
        ...sender,
        name: sender.kind === 'user' ? (users.get(sender.id) ?? 'A former member') : sender.kind === 'api_key' ? (keys.get(sender.id) ?? 'An API key') : 'Scout',
      },
      files: files
        .filter((x) => x.batchId === b.id)
        .map((x) => ({ id: fileIdOf(x.storageKey), fileName: x.fileName, sizeBytes: x.sizeBytes, contentType: x.contentType, sha256: x.sha256, createdAt: x.createdAt })),
      import: f.imp ? { id: f.imp.id, status: f.imp.status, error: stats.error ?? null } : null,
      retryable: s.retryable,
    };
  });
}

export type BatchListFilters = Omit<BatchFilters, 'id' | 'includeCancelled'> & { statusKeys?: BatchStatusKey[] };

export type BatchListMeta = {
  countsByStatus: Record<BatchStatusKey, number>;
  /** The words for each status, for the Status filter (C6). */
  statusLabels: Record<BatchStatusKey, string>;
  /** Batches that failed or need attention, and the first three issues, newest first. */
  attention: { count: number; issues: string[] };
};

/**
 * Every visible batch for the filters, as light views (status and issue), newest first, in a fixed number of reads
 * however many batches there are: the chain-visible set by grouped SQL, the account-visible ones by their visible rows.
 */
async function scanAll(ctx: ModuleContext, f: BatchFilters): Promise<Light[]> {
  const scope = await visibleArrivals(ctx);
  const chain = sql`coalesce(${chainInScope(scope, { person: batch.personSourceId, agent: batch.agentSourceId, vendor: batch.vendorSourceId })}, false)`;
  const where = and(eq(batch.tenantId, ctx.tenantId), ...batchWhere(ctx, f));
  const facts = new Map<string, Facts>();
  const chainRows = await ctx.tx
    .select({ id: batch.id, status: batch.status, runAt: batch.runAt })
    .from(batch)
    .where(and(where, chain));
  const chainSet = ctx.tx.select({ id: batch.id }).from(batch).where(and(where, chain));
  if (chainRows.length > 0) {
    await chainFacts(ctx, chainSet, facts);
    await importFacts(ctx, chainSet, facts);
  }
  const all: { id: string; runAt: Date; light: Light }[] = chainRows.map((r) => ({ id: r.id, runAt: r.runAt, light: lightOf(r.id, factsFor(facts, r.id), r.status) }));
  if (scope.viaAccounts) {
    const otherRows = await ctx.tx
      .select({ id: batch.id, runAt: batch.runAt })
      .from(batch)
      .where(and(where, sql`not ${chain}`));
    const rows = await visibleRowsOfBatches(ctx, otherRows.map((r) => r.id));
    const seen = otherRows.filter((r) => (rows.get(r.id)?.length ?? 0) > 0);
    const seenRows = new Map(seen.map((r) => [r.id, rows.get(r.id)!]));
    rowFacts(seenRows, facts);
    await importFacts(ctx, seen.map((r) => r.id), facts);
    for (const r of seen) {
      const fx = factsFor(facts, r.id);
      all.push({ id: r.id, runAt: r.runAt, light: lightOf(r.id, fx, narrowedStatus(fx)) });
    }
  }
  all.sort((a, b) => b.runAt.getTime() - a.runAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return all.map((x) => x.light);
}

/**
 * GET /batches: a page of rows for the filters, the `total` for all of them, and the status counts with every filter
 * but the status applied (C8).
 */
export async function listBatchRows(
  ctx: ModuleContext,
  f: BatchListFilters,
): Promise<{ data: BatchRowView[]; nextCursor: string | null; total: number; meta: BatchListMeta }> {
  const { statusKeys, cursor, limit, ...base } = f;
  const wanted = statusKeys?.length ? new Set(statusKeys) : null;
  const keep = wanted
    ? async (rows: BatchCandidate[]) => {
        const light = new Map((await lightViews(ctx, rows)).map((l) => [l.id, l.statusKey]));
        return rows.filter((r) => wanted.has(light.get(r.row.id)!));
      }
    : undefined;
  const page = await pageBatches(ctx, { ...base, cursor, limit }, keep);
  const data = await fullViews(ctx, page.data);

  const all = await scanAll(ctx, base);
  const countsByStatus = Object.fromEntries(BATCH_STATUS_KEYS.map((k) => [k, 0])) as Record<BatchStatusKey, number>;
  for (const l of all) countsByStatus[l.statusKey]++;
  const attention = all.filter((l) => l.statusKey === 'needs_attention' || l.statusKey === 'failed');
  return {
    data,
    nextCursor: page.nextCursor,
    total: wanted ? all.filter((l) => wanted.has(l.statusKey)).length : all.length,
    meta: {
      countsByStatus,
      statusLabels: BATCH_STATUS_LABELS,
      attention: { count: attention.length, issues: attention.map((l) => l.issue).filter((x): x is string => !!x).slice(0, 3) },
    },
  };
}

export type BatchDetailRow = BatchRowView & Pick<BatchDetail, 'countsByStage' | 'rejections'>;

/** GET /batches/{id}: the row plus today's counts by stage and rejections. Null when the batch is hidden. */
export async function readBatchRow(ctx: ModuleContext, id: string): Promise<BatchDetailRow | null> {
  const detail = await getBatch(ctx, id);
  if (!detail) return null;
  const found = (await pageBatches(ctx, { id, limit: 1 })).data[0]!;
  const { stages: _stages, countsByStage, rejections, ...view } = detail;
  const [row] = await fullViews(ctx, [found], new Map([[id, view]]));
  return { ...row!, countsByStage, rejections };
}

// ---- Items ----

export const ITEM_STATUSES = ['all', 'waiting', 'resolved', 'rejected'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export type BatchItemView = Awaited<ReturnType<typeof toViews>>[number] & {
  companyName: string | null;
  website: string | null;
  accountName: string | null;
  priority: number | null;
  tier: string | null;
  reviewStatusKey: string | null;
  stage: string | null;
  outcome: ItemOutcome;
  outcomeLabel: string;
};

type Body = { account?: { name?: unknown; website?: unknown; domain?: unknown }; people?: { name?: unknown; first_name?: unknown; last_name?: unknown; email?: unknown; phone?: unknown }[] };

/** The arrival body: the one built from file rows, else what was sent with its item fields moved. */
function bodyOf(r: Pick<ArrivalRow, 'payload'>): Body {
  const p = r.payload as { raw?: unknown; arrival?: unknown };
  const body = (p.arrival ?? moveItemFields(p.raw)) as Body | null;
  return body && typeof body === 'object' ? body : {};
}
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
type Input = { website?: string; company?: { name?: string; website?: string } } | null;

function companyOf(r: ArrivalRow): { name: string | null; website: string | null } {
  const acc = bodyOf(r).account ?? {};
  const input = r.resolutionInput as Input;
  return {
    name: text(input?.company?.name) ?? text(acc.name),
    website: text(input?.website) ?? text(input?.company?.website) ?? text(acc.website) ?? text(acc.domain),
  };
}

const itemWhere = (batchId: string, status: ItemStatus) => [
  eq(arrival.batchId, batchId),
  notSuperseded,
  status === 'waiting'
    ? and(eq(arrival.status, 'resolving'), isNotNull(arrival.waitingOn))
    : status === 'resolved'
      ? eq(arrival.status, 'resolved')
      : status === 'rejected'
        ? eq(arrival.status, 'rejected')
        : undefined,
];

/**
 * GET /batches/{id}/items: the batch's rows the principal may see, newest first, with the company, its account's
 * name, priority, tier and stage (null where the caller may not see the account) and the outcome. Null when the batch is hidden.
 */
export async function listBatchItemRows(
  ctx: ModuleContext,
  batchId: string,
  f: { status?: ItemStatus; cursor?: string; limit?: number } = {},
): Promise<{ data: BatchItemView[]; nextCursor: string | null; total: number } | null> {
  if (!(await pageBatches(ctx, { id: batchId, limit: 1 })).data[0]) return null;
  const where = itemWhere(batchId, f.status ?? 'all');
  const page = await pageArrivals(ctx, { where, cursor: f.cursor, limit: f.limit });
  const views = await toViews(ctx, page.data);
  const accountIds = [...new Set(page.data.map((r) => r.accountId).filter((x): x is string => !!x))];
  const summaries = new Map((await getSummaries(ctx, accountIds)).map((s) => [s.accountId, s]));
  const names = await accountNames(ctx, accountIds);
  const data = page.data.map((r, i) => {
    const s = r.accountId ? summaries.get(r.accountId) : undefined;
    const accountName = r.accountId ? (names.get(r.accountId) ?? null) : null;
    const company = companyOf(r);
    const o = itemOutcome({ status: r.status, resolution: r.resolution, reason: r.rejectReason, waitingOn: r.waitingOn, accountName });
    return {
      ...views[i]!,
      companyName: company.name ?? accountName,
      website: company.website,
      accountName,
      priority: s?.priority ?? null,
      tier: s?.tier ?? null,
      reviewStatusKey: s?.reviewStatusKey ?? null,
      stage: s?.stage ?? null,
      outcome: o.outcome,
      outcomeLabel: o.label,
    };
  });
  return { data, nextCursor: page.nextCursor, total: await countArrivals(ctx, where) };
}

// ---- Files and the error report ----

/** One original file of a batch whose chain the caller sees, by its id; null otherwise, or when the file is not there. */
export async function readBatchFile(ctx: ModuleContext, batchId: string, fileId: string): Promise<(StoredFile & { bytes: Buffer }) | null> {
  // The upload holds every row, so a batch seen only through account visibility has no file to give.
  if (!(await pageBatches(ctx, { id: batchId, limit: 1 })).data[0]?.chainOk) return null;
  const keys = await ctx.tx
    .select({ storageKey: batchFile.storageKey })
    .from(batchFile)
    .where(and(eq(batchFile.tenantId, ctx.tenantId), eq(batchFile.batchId, batchId)));
  const key = keys.find((k) => fileIdOf(k.storageKey) === fileId);
  return key ? readFile(ctx, batchId, key.storageKey) : null;
}

export type RejectionRow = { row: number; company: string; website: string; reason: string; detail: string; person: string; email: string; phone: string };

/** The batch's rejected rows the caller may see, oldest first, for the error report. Null when the batch is hidden. */
export async function rejectionRows(ctx: ModuleContext, batchId: string): Promise<RejectionRow[] | null> {
  if (!(await getBatch(ctx, batchId))) return null;
  const rows: ArrivalRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await pageArrivals(ctx, { where: itemWhere(batchId, 'rejected'), cursor, limit: 200 });
    rows.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows.reverse().map((r, i) => {
    const body = bodyOf(r);
    const p = body.people?.[0] ?? {};
    const company = companyOf(r);
    return {
      row: i + 1,
      company: company.name ?? '',
      website: company.website ?? '',
      reason: REJECT_REASON_LABELS[r.rejectReason ?? ''] ?? r.rejectReason ?? '',
      detail: r.rejectDetail ?? '',
      person: text(p.name) ?? [text(p.first_name), text(p.last_name)].filter(Boolean).join(' '),
      email: text(p.email) ?? '',
      phone: text(p.phone) ?? '',
    };
  });
}

export const invalidFilter = (path: string, title: string) => new ScoutError({ slug: 'validation', status: 400, title, errors: [{ path, message: title }] });
