import { and, desc, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { filterVisibleAccountIds } from '@/modules/accounts';
import type { DataLimit } from '@/platform/access';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { arrival } from '../db/schema';
import { childSources } from './sources';

type ArrivalRow = typeof arrival.$inferSelect;
type Chain = { person: SQLWrapper; agent: SQLWrapper; vendor: SQLWrapper };

/**
 * What the principal's data limit lets them see (TEN-E3-S1-AC2): everything, rows whose source chain
 * touches `sourceIds`, and/or resolved arrivals whose account Accounts lets them see (`viaAccounts`).
 */
export type ArrivalScope = { all: boolean; sourceIds: string[]; viaAccounts: boolean };

async function collect(ctx: ModuleContext, limit: DataLimit, into: ArrivalScope): Promise<void> {
  const access = ctx.access;
  switch (limit.kind) {
    case 'all':
      into.all = true;
      return;
    case 'own_source': {
      if (!access?.sourceId) return;
      const children = await childSources(ctx, [access.sourceId]);
      into.sourceIds.push(access.sourceId, ...(access.childSourceIds ?? []), ...children);
      return;
    }
    case 'sources':
      into.sourceIds.push(...limit.ids, ...(await childSources(ctx, limit.ids)));
      return;
    case 'practices':
    case 'own_accounts':
      into.viaAccounts = true;
      return;
    case 'any_of':
      for (const l of limit.limits) await collect(ctx, l, into);
  }
}

/** The principal's scope. Worker and scheduler contexts have no `access` and see the whole tenant. */
export async function visibleArrivals(ctx: ModuleContext): Promise<ArrivalScope> {
  const scope: ArrivalScope = { all: !ctx.access, sourceIds: [], viaAccounts: false };
  if (ctx.access) await collect(ctx, ctx.access.dataLimit, scope);
  scope.sourceIds = [...new Set(scope.sourceIds)];
  return scope;
}

/** True when the row's source chain (an arrival's or a batch's columns) touches the scope's sources. */
export function chainInScope(scope: ArrivalScope, c: Chain): SQL {
  if (scope.all) return sql`true`;
  if (scope.sourceIds.length === 0) return sql`false`;
  const ids = sql.join(scope.sourceIds.map((id) => sql`${id}`), sql`, `);
  return sql`(${c.person} in (${ids}) or ${c.agent} in (${ids}) or ${c.vendor} in (${ids}))`;
}

const arrivalChain: Chain = { person: arrival.personSourceId, agent: arrival.agentSourceId, vendor: arrival.vendorSourceId };

// ---- Keyset paging ----

type Key = [string, string];
const encode = (k: Key) => Buffer.from(JSON.stringify(k)).toString('base64url');
function decode(cursor: string): Key {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && !Number.isNaN(Date.parse(v[0]))) {
      return [v[0], v[1]];
    }
  } catch {
    // fall through
  }
  throw new ScoutError({ slug: 'invalid-cursor', status: 400, title: 'Invalid cursor' });
}

export const clampLimit = (limit: number | undefined) => Math.min(Math.max(limit ?? 50, 1), 200);

/**
 * Reads candidate pages after the cursor and keeps what `keep` allows, until `limit` rows are kept or
 * the rows run out, so paging stays correct however few candidates pass. Keys are (time as Postgres
 * text, id), newest first.
 */
export async function keysetPage<T>(o: {
  cursor?: string;
  limit?: number;
  fetch: (after: Key | null, size: number) => Promise<{ item: T; key: Key }[]>;
  keep: (items: T[]) => Promise<T[]>;
}): Promise<{ data: T[]; nextCursor: string | null }> {
  const limit = clampLimit(o.limit);
  const size = Math.max(limit + 1, 50);
  let after = o.cursor ? decode(o.cursor) : null;
  const kept: { item: T; key: Key }[] = [];
  for (;;) {
    const rows = await o.fetch(after, size);
    const ok = new Set(await o.keep(rows.map((r) => r.item)));
    for (const r of rows) {
      if (!ok.has(r.item)) continue;
      kept.push(r);
      if (kept.length > limit) break;
    }
    if (kept.length > limit || rows.length < size) break;
    after = rows[rows.length - 1]!.key;
  }
  const data = kept.slice(0, limit);
  return { data: data.map((d) => d.item), nextCursor: kept.length > limit ? encode(data[limit - 1]!.key) : null };
}


type Candidate = { row: ArrivalRow; chainOk: boolean };

/** Candidates the principal may see: by chain (already known) or by their account's visibility. */
async function visibleRows(ctx: ModuleContext, rows: Candidate[]): Promise<Candidate[]> {
  const viaAccount = rows.filter((r) => !r.chainOk && r.row.accountId);
  const seen = new Set(await filterVisibleAccountIds(ctx, [...new Set(viaAccount.map((r) => r.row.accountId!))]));
  return rows.filter((r) => r.chainOk || (r.row.accountId && seen.has(r.row.accountId)));
}

/** Arrivals the principal may see, newest first, narrowed by `where`. */
export async function pageArrivals(
  ctx: ModuleContext,
  o: { where?: (SQL | undefined)[]; cursor?: string; limit?: number },
): Promise<{ data: ArrivalRow[]; nextCursor: string | null }> {
  const scope = await visibleArrivals(ctx);
  const chain = chainInScope(scope, arrivalChain);
  const candidate = scope.viaAccounts ? sql`(${chain} or (${arrival.status} = 'resolved' and ${arrival.accountId} is not null))` : chain;
  const page = await keysetPage<Candidate>({
    cursor: o.cursor,
    limit: o.limit,
    fetch: async (after, size) => {
      const rows = await ctx.tx
        .select({ row: arrival, atText: sql<string>`${arrival.receivedAt}::text`, chainOk: sql<boolean>`${chain}` })
        .from(arrival)
        .where(
          and(
            eq(arrival.tenantId, ctx.tenantId),
            candidate,
            ...(o.where ?? []),
            after ? sql`(${arrival.receivedAt}, ${arrival.id}) < (${after[0]}::timestamptz, ${after[1]})` : undefined,
          ),
        )
        .orderBy(desc(arrival.receivedAt), desc(arrival.id))
        .limit(size);
      return rows.map((r) => ({ item: { row: r.row, chainOk: r.chainOk }, key: [r.atText, r.row.id] as Key }));
    },
    keep: (items) => visibleRows(ctx, items),
  });
  return { data: page.data.map((c) => c.row), nextCursor: page.nextCursor };
}

/** One arrival the principal may see, or null (also when it does not exist). */
export async function findArrival(ctx: ModuleContext, id: string): Promise<ArrivalRow | null> {
  return (await pageArrivals(ctx, { where: [eq(arrival.id, id)], limit: 1 })).data[0] ?? null;
}
