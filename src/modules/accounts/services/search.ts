import { and, asc, eq, exists, gte, ilike, isNotNull, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { account, accountAlias, accountSummary, signal } from '../db/schema';
import { visibleAccounts } from './visibility';

export type SearchSort = 'priority' | 'last_signal' | 'created' | 'name';

/** Every ACC-E8 filter. Scoring, review and CRM columns stay empty until R1b and R1c, so filters on them match nothing for now. */
export type SearchQuery = {
  text?: string;
  industry?: string;
  employeesMin?: number;
  employeesMax?: number;
  revenueMinCents?: number;
  revenueMaxCents?: number;
  hqCountry?: string;
  hqState?: string;
  practiceId?: string;
  bestOfferId?: string;
  tier?: string;
  priorityMin?: number;
  reviewStatusKey?: string;
  stage?: string;
  ownerUserId?: string;
  unassigned?: boolean;
  sourceId?: string;
  signalKind?: string;
  signalSince?: Date;
  excluded?: boolean;
  sort?: SearchSort;
  limit?: number;
  cursor?: string;
};

export type SearchRow = {
  accountId: string;
  name: string;
  domain: string | null;
  tier: string | null;
  priority: number | null;
  bestOfferId: string | null;
  reviewStatusKey: string | null;
  stage: string | null;
  ownerUserId: string | null;
  lastSignalAt: Date | null;
  excludedReasonKey: string | null;
  createdAt: Date;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Each sort is one key plus the account id as tie-break. Nulls sort last. */
const SORTS: Record<SearchSort, { expr: SQL; cast: 'int' | 'timestamptz' | 'text'; dir: 'asc' | 'desc' }> = {
  priority: { expr: sql`${accountSummary.priority}`, cast: 'int', dir: 'desc' },
  last_signal: { expr: sql`${accountSummary.lastSignalAt}`, cast: 'timestamptz', dir: 'desc' },
  created: { expr: sql`${account.createdAt}`, cast: 'timestamptz', dir: 'desc' },
  name: { expr: sql`${account.name}`, cast: 'text', dir: 'asc' },
};

/** The sort key travels as text so timestamps keep their microseconds. */
type Cursor = { sort: SearchSort; key: string | null; id: string };

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(raw: string, sort: SearchSort): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (c.sort === sort && typeof c.id === 'string' && (c.key === null || typeof c.key === 'string')) return c;
  } catch {
    // falls through to the error below
  }
  throw new ScoutError({ slug: 'bad-request', status: 400, title: 'That cursor is not valid.' });
}

/** Rows strictly after the cursor in the sort order (nulls come last). */
function afterCursor(sort: SearchSort, c: Cursor): SQL {
  const { expr, cast, dir } = SORTS[sort];
  const idAfter = sql`${account.id} > ${c.id}`;
  if (c.key === null) return and(sql`${expr} is null`, idAfter) as SQL;
  const key = sql`${c.key}::${sql.raw(cast)}`;
  const past = dir === 'desc' ? sql`${expr} < ${key}` : sql`${expr} > ${key}`;
  return or(past, sql`${expr} is null`, and(sql`${expr} = ${key}`, idAfter)) as SQL;
}

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

function filters(ctx: ModuleContext, q: SearchQuery): (SQL | undefined)[] {
  const like = q.text?.trim() ? likePattern(q.text.trim()) : undefined;
  return [
    like
      ? or(
          ilike(account.name, like),
          ilike(account.domain, like),
          exists(
            ctx.tx
              .select({ one: sql`1` })
              .from(accountAlias)
              .where(and(eq(accountAlias.accountId, account.id), ne(accountAlias.kind, 'merged_id'), ilike(accountAlias.value, like))),
          ),
        )
      : undefined,
    q.industry ? or(eq(account.industryKey, q.industry), eq(account.industry, q.industry)) : undefined,
    q.employeesMin !== undefined ? gte(account.employees, q.employeesMin) : undefined,
    q.employeesMax !== undefined ? lte(account.employees, q.employeesMax) : undefined,
    q.revenueMinCents !== undefined ? gte(account.revenueCents, q.revenueMinCents) : undefined,
    q.revenueMaxCents !== undefined ? lte(account.revenueCents, q.revenueMaxCents) : undefined,
    q.hqCountry ? eq(account.hqCountry, q.hqCountry) : undefined,
    q.hqState ? or(eq(account.hqStateKey, q.hqState), eq(account.hqState, q.hqState)) : undefined,
    q.practiceId
      ? or(sql`${accountSummary.practiceIds} @> ARRAY[${q.practiceId}]::text[]`, eq(accountSummary.practiceId, q.practiceId))
      : undefined,
    q.bestOfferId ? eq(accountSummary.bestOfferId, q.bestOfferId) : undefined,
    q.tier ? eq(accountSummary.tier, q.tier) : undefined,
    q.priorityMin !== undefined ? gte(accountSummary.priority, q.priorityMin) : undefined,
    q.reviewStatusKey ? eq(accountSummary.reviewStatusKey, q.reviewStatusKey) : undefined,
    q.stage ? eq(accountSummary.stage, q.stage) : undefined,
    q.ownerUserId ? eq(accountSummary.ownerUserId, q.ownerUserId) : undefined,
    q.unassigned ? isNull(accountSummary.ownerUserId) : undefined,
    q.sourceId ? sql`${accountSummary.sourceIds} @> ARRAY[${q.sourceId}]::text[]` : undefined,
    q.signalKind || q.signalSince
      ? exists(
          ctx.tx
            .select({ one: sql`1` })
            .from(signal)
            .where(
              and(
                eq(signal.accountId, account.id),
                isNull(signal.archivedAt),
                q.signalKind ? eq(signal.kind, q.signalKind) : undefined,
                q.signalSince ? gte(signal.occurredAt, q.signalSince) : undefined,
              ),
            ),
        )
      : undefined,
    q.excluded === undefined ? undefined : q.excluded ? isNotNull(account.excludedReasonKey) : isNull(account.excludedReasonKey),
  ];
}

/**
 * Finds accounts the principal may see (data limits apply first), with every filter ANDed, paged by
 * a keyset cursor. Archived accounts keep their summary row but are never returned.
 */
export async function search(ctx: ModuleContext, q: SearchQuery = {}): Promise<{ data: SearchRow[]; nextCursor: string | null }> {
  const sort = q.sort ?? 'priority';
  const spec = SORTS[sort];
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const cursor = q.cursor ? decodeCursor(q.cursor, sort) : undefined;
  const keyOrder = spec.dir === 'desc' ? sql`${spec.expr} desc nulls last` : sql`${spec.expr} asc nulls last`;

  const rows = await ctx.tx
    .select({
      accountId: account.id,
      name: account.name,
      domain: account.domain,
      tier: accountSummary.tier,
      priority: accountSummary.priority,
      bestOfferId: accountSummary.bestOfferId,
      reviewStatusKey: accountSummary.reviewStatusKey,
      stage: accountSummary.stage,
      ownerUserId: accountSummary.ownerUserId,
      lastSignalAt: accountSummary.lastSignalAt,
      excludedReasonKey: account.excludedReasonKey,
      createdAt: account.createdAt,
      cursorKey: sql<string | null>`(${spec.expr})::text`,
    })
    .from(accountSummary)
    .innerJoin(account, eq(account.id, accountSummary.accountId))
    .where(
      and(
        eq(accountSummary.tenantId, ctx.tenantId),
        eq(account.tenantId, ctx.tenantId),
        isNull(account.archivedAt),
        await visibleAccounts(ctx),
        ...filters(ctx, q),
        cursor ? afterCursor(sort, cursor) : undefined,
      ),
    )
    .orderBy(keyOrder, asc(account.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const data = page.map(({ cursorKey: _key, ...row }) => row);
  return { data, nextCursor: rows.length > limit && last ? encodeCursor({ sort, key: last.cursorKey, id: last.accountId }) : null };
}
