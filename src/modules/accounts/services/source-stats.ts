import { sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { accountSummary } from '../db/schema';
import { visibleAccounts } from './visibility';

/** A source and the sources its numbers include: itself and everything below it. */
export type SourceGroup = { sourceId: string; memberIds: string[] };

/**
 * Per source, how many accounts sit at each stage (`null` for an account with no stage yet), counting an account
 * once when any source of the group is in its `source_ids`, under the caller's data limit (Ruling 4).
 */
export async function stageCountsBySource(ctx: ModuleContext, groups: SourceGroup[]): Promise<Map<string, Map<string | null, number>>> {
  const out = new Map<string, Map<string | null, number>>(groups.map((g) => [g.sourceId, new Map()]));
  const pairs = groups.flatMap((g) => [...new Set([g.sourceId, ...g.memberIds])].map((m) => sql`(${g.sourceId}::text, ${m}::text)`));
  if (pairs.length === 0) return out;
  const visible = await visibleAccounts(ctx);
  const rows = (await ctx.tx.execute(sql`
    with g(source_id, member_id) as (values ${sql.join(pairs, sql`, `)})
    select g.source_id, ${accountSummary.stage} as stage, count(distinct ${accountSummary.accountId})::int as n
    from ${accountSummary}
    join g on g.member_id = any(${accountSummary.sourceIds})
    where ${accountSummary.tenantId} = ${ctx.tenantId} and ${visible}
    group by g.source_id, ${accountSummary.stage}
  `)) as unknown as { source_id: string; stage: string | null; n: number }[];
  for (const r of rows) out.get(r.source_id)?.set(r.stage, Number(r.n));
  return out;
}
