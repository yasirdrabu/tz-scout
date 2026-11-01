import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { stageCountsBySource } from '@/modules/accounts';
import { STAGES } from '@/modules/routing/contracts/types';
import { activeKeysBySource, userNames, type ActiveKey } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { arrival, batch, source } from '../db/schema';
import { syncStatus, type SyncStatus } from './qualified-leads';
import { childSources, liveChildCounts, readSource, sourceBreadcrumb, sourceNames, type SourceKind, type SourceListRow, type SourceStatus, type SourceView } from './sources';

export const KIND_LABELS: Record<SourceKind, string> = {
  person: 'Person',
  agent: 'Agent',
  vendor: 'Data vendor',
  list: 'List',
  partner: 'Partner',
  crm: 'CRM',
  web_form: 'Web form',
  scheduled_pull: 'Scheduled pull',
};

const STATUS_LABELS: Record<Exclude<SourceStatus, 'removed'>, string> = { active: 'Active', paused: 'Paused', archived: 'Archived' };

/** Trust is the R1 constant until R3 learns it from outcomes (C9). */
export const TRUST_LABEL = 'Not enough data yet';

/** Fewer reviewed accounts than this and a source is "New" (Ruling 4). */
const NEW_UNDER_REVIEWED = 10;

export type SendMethod = 'api_key' | 'through_parent' | 'file_upload' | 'hubspot_sync' | 'none';

/** One source as Sources and the Source page show it. */
export type SourceApiView = {
  id: string;
  name: string;
  kind: SourceKind;
  kindLabel: string;
  status: SourceStatus;
  statusLabel: string;
  parentId: string | null;
  parent: { id: string; name: string; kind: string } | null;
  owner: { userId: string; name: string } | null;
  method: SendMethod;
  methodLabel: string;
  activeKey: ActiveKey | null;
  createdAt: Date;
  lastSentAt: Date | null;
  hasSent: boolean;
  arrivalsLast30Days: number;
  trust: null;
  trustLabel: string;
  childrenCount: number;
  isNew: boolean;
  canRemove: boolean;
  canArchive: boolean;
  userId: string | null;
  ownerUserId: string | null;
  dailyArrivalCap: number;
  initialReviewStatusKey: string;
};

export type SourceFunnel = {
  sent: number;
  reviewed: number;
  assigned: number;
  won: number;
  reviewedPct: number | null;
  assignedPct: number | null;
  wonPct: number | null;
  byStage: { key: string; count: number }[];
  isNew: boolean;
};

const pct = (n: number, base: number): number | null => (base === 0 ? null : Math.round((n / base) * 100));

/**
 * Ruling 4: Sent is every account; Reviewed, Assigned and Won are cumulative by funnel rank, and an exit (declined,
 * lost) counts in Sent and Reviewed only. An account with no stage yet has arrived.
 */
export function sourceFunnel(counts: Map<string | null, number>): SourceFunnel {
  const at = (k: string) => (counts.get(k) ?? 0) + (k === 'arrived' ? (counts.get(null) ?? 0) : 0);
  const sent = [...counts.values()].reduce((s, n) => s + n, 0);
  const reviewed = sent - at('arrived');
  const assigned = at('assigned') + at('engaged') + at('opportunity') + at('won');
  const won = at('won');
  return {
    sent,
    reviewed,
    assigned,
    won,
    reviewedPct: pct(reviewed, sent),
    assignedPct: pct(assigned, reviewed),
    wonPct: pct(won, assigned),
    byStage: STAGES.map((key) => ({ key, count: at(key) })),
    isNew: reviewed < NEW_UNDER_REVIEWED,
  };
}

/** Every source that is not removed, with the sources under it at any depth. */
async function descendants(ctx: ModuleContext): Promise<Map<string, string[]>> {
  const rows = await ctx.tx
    .select({ id: source.id, parentId: source.parentId })
    .from(source)
    .where(and(eq(source.tenantId, ctx.tenantId), ne(source.status, 'removed')));
  const kids = new Map<string, string[]>();
  for (const r of rows) if (r.parentId) kids.set(r.parentId, [...(kids.get(r.parentId) ?? []), r.id]);
  const below = (id: string, seen = new Set<string>()): string[] =>
    (kids.get(id) ?? []).flatMap((c) => (seen.has(c) ? [] : (seen.add(c), [c, ...below(c, seen)])));
  return new Map(rows.map((r) => [r.id, below(r.id)]));
}

/** The funnel of each given source with its children rolled up, over the accounts the caller can see. */
export async function sourceStats(ctx: ModuleContext, sourceIds: string[]): Promise<Map<string, SourceFunnel>> {
  const tree = await descendants(ctx);
  const groups = sourceIds.map((id) => ({ sourceId: id, memberIds: tree.get(id) ?? [] }));
  const counts = await stageCountsBySource(ctx, groups);
  return new Map(sourceIds.map((id) => [id, sourceFunnel(counts.get(id) ?? new Map())]));
}

function methodOf(row: SourceListRow, parentName: string | null, key: ActiveKey | undefined): { method: SendMethod; methodLabel: string } {
  if (row.kind === 'agent' || row.kind === 'scheduled_pull') return { method: 'through_parent', methodLabel: `Through ${parentName ?? 'its parent'}` };
  if (row.kind === 'list') return { method: 'file_upload', methodLabel: 'File upload' };
  if (row.kind === 'crm') return { method: 'hubspot_sync', methodLabel: 'HubSpot sync' };
  return key ? { method: 'api_key', methodLabel: 'API key' } : { method: 'none', methodLabel: 'Not sending yet' };
}

/** The list rows as the API shows them: labels, parent, owner name, how it sends, its key, and what may be done to it. */
export async function sourceViews(ctx: ModuleContext, rows: SourceListRow[], stats?: Map<string, SourceFunnel>): Promise<SourceApiView[]> {
  const ids = rows.map((r) => r.id);
  const parentIds = [...new Set(rows.map((r) => r.parentId).filter((id): id is string => !!id))];
  const [keys, owners, children, funnels, parents] = await Promise.all([
    activeKeysBySource(ctx, ids),
    userNames(ctx, rows.map((r) => r.ownerUserId).filter((id): id is string => !!id)),
    liveChildCounts(ctx, ids),
    stats ?? sourceStats(ctx, ids),
    parentIds.length
      ? ctx.tx
          .select({ id: source.id, name: source.name, kind: source.kind })
          .from(source)
          .where(and(eq(source.tenantId, ctx.tenantId), ne(source.status, 'removed')))
          .then((all) => new Map(all.filter((p) => parentIds.includes(p.id)).map((p) => [p.id, p])))
      : Promise.resolve(new Map<string, { id: string; name: string; kind: string }>()),
  ]);
  return rows.map((r) => {
    const parent = r.parentId ? (parents.get(r.parentId) ?? null) : null;
    const key = keys.get(r.id);
    const childrenCount = children.get(r.id) ?? 0;
    const live = r.status !== 'archived';
    const ownerName = r.ownerUserId ? owners.get(r.ownerUserId) : undefined;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      kindLabel: KIND_LABELS[r.kind] ?? r.kind,
      status: r.status,
      statusLabel: STATUS_LABELS[r.status as Exclude<SourceStatus, 'removed'>] ?? r.status,
      parentId: r.parentId,
      parent,
      owner: r.ownerUserId && ownerName ? { userId: r.ownerUserId, name: ownerName } : null,
      ...methodOf(r, parent?.name ?? null, key),
      activeKey: key ?? null,
      createdAt: r.createdAt,
      lastSentAt: r.lastSentAt,
      hasSent: r.hasSent,
      arrivalsLast30Days: r.arrivalsLast30Days,
      trust: null,
      trustLabel: TRUST_LABEL,
      childrenCount,
      isNew: funnels.get(r.id)?.isNew ?? true,
      canRemove: !r.hasSent && childrenCount === 0 && live,
      canArchive: r.hasSent && childrenCount === 0 && live,
      userId: r.userId,
      ownerUserId: r.ownerUserId,
      dailyArrivalCap: r.dailyArrivalCap,
      initialReviewStatusKey: r.initialReviewStatusKey,
    };
  });
}

export type SourceDetail = SourceApiView & { breadcrumb: { id: string; name: string }[]; sync: SyncStatus | null };

/** One source for the Source page; undefined when it is removed, hidden or another tenant's. */
export async function sourceDetail(ctx: ModuleContext, id: string): Promise<SourceDetail | undefined> {
  const row = await readSource(ctx, id);
  return row ? detailOf(ctx, row) : undefined;
}

/** A source just added, as the Source page reads it, even when the caller's limit would not show it (a key that added it). */
export async function newSourceDetail(ctx: ModuleContext, added: SourceView): Promise<SourceDetail> {
  return detailOf(ctx, { ...added, arrivalsLast30Days: 0, lastSentAt: null, hasSent: false });
}

async function detailOf(ctx: ModuleContext, row: SourceListRow): Promise<SourceDetail> {
  const [v] = await sourceViews(ctx, [row]);
  return { ...v!, breadcrumb: await sourceBreadcrumb(ctx, row.id), sync: row.kind === 'crm' ? await syncStatus(ctx) : null };
}

/** How an account first came in through a source, for the Source page's Accounts tab ("Came in through"). */
export type FirstArrival = { at: Date; batchId: string | null; batchName: string | null; sourceId: string; sourceName: string };

/**
 * Each account's earliest resolved arrival through the source or a source below it, with its batch and its closest
 * source (the agent or list, else the person, else the vendor). The caller has checked the accounts are visible.
 */
export async function firstArrivals(ctx: ModuleContext, accountIds: string[], sourceId: string): Promise<Map<string, FirstArrival>> {
  if (accountIds.length === 0) return new Map();
  const sources = [sourceId, ...(await childSources(ctx, [sourceId]))];
  const rows = await ctx.tx
    .selectDistinctOn([arrival.accountId], {
      accountId: arrival.accountId,
      at: arrival.receivedAt,
      batchId: arrival.batchId,
      batchName: batch.name,
      closest: sql<string>`coalesce(${arrival.agentSourceId}, ${arrival.personSourceId}, ${arrival.vendorSourceId})`,
    })
    .from(arrival)
    .leftJoin(batch, and(eq(batch.tenantId, arrival.tenantId), eq(batch.id, arrival.batchId)))
    .where(
      and(
        eq(arrival.tenantId, ctx.tenantId),
        eq(arrival.status, 'resolved'),
        inArray(arrival.accountId, accountIds),
        or(inArray(arrival.personSourceId, sources), inArray(arrival.agentSourceId, sources), inArray(arrival.vendorSourceId, sources)),
      ),
    )
    .orderBy(asc(arrival.accountId), asc(arrival.receivedAt), asc(arrival.id));
  const names = await sourceNames(ctx, [...new Set(rows.map((r) => r.closest))]);
  return new Map(
    rows.map((r) => [r.accountId!, { at: r.at, batchId: r.batchId, batchName: r.batchName, sourceId: r.closest, sourceName: names.get(r.closest) ?? r.closest }]),
  );
}
