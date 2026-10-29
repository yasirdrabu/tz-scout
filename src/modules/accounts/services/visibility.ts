import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { DataLimit } from '@/platform/access';
import type { ModuleContext } from '@/platform/context';
import { sourceAccessProvider } from '../contracts/ports';
import { accountSummary } from '../db/schema';

const textArrayOf = (values: string[]) => sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;
export const overlaps = (column: SQL | typeof accountSummary.sourceIds, values: string[]): SQL =>
  values.length === 0 ? sql`false` : sql`${column} && ${textArrayOf(values)}`;

async function limitCondition(ctx: ModuleContext, limit: DataLimit): Promise<SQL> {
  const access = ctx.access;
  switch (limit.kind) {
    case 'all':
      return sql`true`;
    case 'own_source': {
      if (!access?.sourceId) return sql`false`;
      const children = await sourceAccessProvider().childSources(ctx, [access.sourceId]);
      return overlaps(accountSummary.sourceIds, [...new Set([access.sourceId, ...(access.childSourceIds ?? []), ...children])]);
    }
    case 'sources': {
      const children = await sourceAccessProvider().childSources(ctx, limit.ids);
      return overlaps(accountSummary.sourceIds, [...new Set([...limit.ids, ...children])]);
    }
    case 'practices':
      return limit.ids.length === 0
        ? sql`false`
        : (or(overlaps(accountSummary.practiceIds, limit.ids), inArray(accountSummary.practiceId, limit.ids)) as SQL);
    case 'own_accounts': {
      const mine: (SQL | undefined)[] = [
        access?.userId ? eq(accountSummary.ownerUserId, access.userId) : undefined,
        access?.userId ? overlaps(accountSummary.ownerHistoryUserIds, [access.userId]) : undefined,
        access?.sourceId ? overlaps(accountSummary.sourceIds, [access.sourceId]) : undefined,
      ];
      return or(...mine) ?? sql`false`;
    }
    case 'any_of': {
      const parts = await Promise.all(limit.limits.map((l) => limitCondition(ctx, l)));
      return or(...parts) ?? sql`false`;
    }
  }
}

/** Whether the principal sees the whole tenant: system contexts (no access) and the `all` limit. */
const unrestricted = (ctx: ModuleContext): boolean => !ctx.access || ctx.access.dataLimit.kind === 'all';

/** A condition on `account_summary` that keeps only the rows the principal's data limit allows. */
export async function visibleAccounts(ctx: ModuleContext): Promise<SQL> {
  if (unrestricted(ctx)) return sql`true`;
  return limitCondition(ctx, ctx.access!.dataLimit);
}

/** The subset of `ids` the principal can see, in the order given. */
export async function filterVisibleAccountIds(ctx: ModuleContext, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  if (unrestricted(ctx)) return ids;
  const rows = await ctx.tx
    .select({ id: accountSummary.accountId })
    .from(accountSummary)
    .where(and(eq(accountSummary.tenantId, ctx.tenantId), inArray(accountSummary.accountId, ids), await visibleAccounts(ctx)));
  const ok = new Set(rows.map((r) => r.id));
  return ids.filter((id) => ok.has(id));
}
