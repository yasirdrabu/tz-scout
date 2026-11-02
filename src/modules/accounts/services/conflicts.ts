import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { conflictDetected } from '../contracts/events';
import type { SourceChain } from '../contracts/types';
import { accountSummary, conflict, fact } from '../db/schema';
import { differs, toleranceFor } from '../domain/conflicts';
import type { PickFact } from '../domain/current-value';

/** One picked key of the account or a person: its current fact and its live (not superseded) facts. */
export type ConflictGroup = { personId: string | null; key: string; currentId: string; live: PickFact[] };

const chainKey = (c: SourceChain) => `${c.personSourceId ?? ''}|${c.agentSourceId ?? ''}|${c.vendorSourceId ?? ''}`;
const textArray = (ids: string[]) => sql`array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::text[]`;

/** The live facts from other source chains that differ from the current value beyond the key's tolerance (Ruling 4). */
export function disagreeingIds(g: ConflictGroup): string[] {
  if (!toleranceFor(g.key)) return [];
  const current = g.live.find((f) => f.id === g.currentId);
  if (!current) return [];
  return g.live
    .filter((f) => f.id !== current.id && chainKey(f.sourceChain) !== chainKey(current.sourceChain) && differs(g.key, current.value, f.value))
    .map((f) => f.id);
}

/**
 * Opens the key's conflict, or adds the disagreeing facts to its open one (one open conflict per account, person
 * and key; the partial unique index enforces it). The caller holds the account lock. Returns the ids of the
 * conflicts opened or extended, and recounts the summary when there are any.
 */
export async function detectConflicts(ctx: ModuleContext, accountId: string, groups: ConflictGroup[]): Promise<string[]> {
  const changed: string[] = [];
  for (const g of groups) {
    const others = disagreeingIds(g);
    if (others.length === 0) continue;
    const factIds = [g.currentId, ...others];
    // Returns a row only when the conflict is new or gained a fact.
    const [row] = (await ctx.tx.execute(sql`
      insert into accounts.conflict (id, tenant_id, account_id, person_id, key, fact_ids)
      values (${newId('cfl')}, ${ctx.tenantId}, ${accountId}, ${g.personId}, ${g.key}, ${textArray(factIds)})
      on conflict (tenant_id, account_id, coalesce(person_id, ''), key) where status = 'open'
      do update set fact_ids = conflict.fact_ids || array(select f from unnest(excluded.fact_ids) as f where f <> all(conflict.fact_ids))
      where not (excluded.fact_ids <@ conflict.fact_ids)
      returning id, fact_ids
    `)) as unknown as { id: string; fact_ids: string[] }[];
    if (!row) continue;
    await conflictChanged(ctx, { id: row.id, accountId, personId: g.personId, key: g.key, factIds: row.fact_ids });
    changed.push(row.id);
  }
  if (changed.length) await recountOpenConflicts(ctx, accountId);
  return changed;
}

/** The one place a conflict has just opened or gained a fact. */
async function conflictChanged(
  ctx: ModuleContext,
  c: { id: string; accountId: string; personId: string | null; key: string; factIds: string[] },
): Promise<void> {
  const chains = await ctx.tx
    .select({ personSourceId: fact.personSourceId, agentSourceId: fact.agentSourceId, vendorSourceId: fact.vendorSourceId })
    .from(fact)
    .where(and(eq(fact.tenantId, ctx.tenantId), inArray(fact.id, c.factIds)));
  const sourceIds = [...new Set(chains.flatMap((r) => [r.personSourceId, r.agentSourceId, r.vendorSourceId]).filter((s): s is string => !!s))].sort();
  await publish(
    ctx,
    conflictDetected,
    { conflictId: c.id, accountId: c.accountId, ...(c.personId ? { personId: c.personId } : {}), key: c.key, factIds: c.factIds, sourceIds },
    { type: 'account', id: c.accountId },
  );
}

/** Writes `account_summary.open_conflict_count` from the conflict table. */
export async function recountOpenConflicts(ctx: ModuleContext, accountId: string): Promise<void> {
  await ctx.tx
    .update(accountSummary)
    .set({
      openConflictCount: sql`(select count(*)::int from ${conflict} where ${conflict.tenantId} = ${ctx.tenantId}
        and ${conflict.accountId} = ${accountId} and ${conflict.status} = 'open')`,
      updatedAt: new Date(),
    })
    .where(and(eq(accountSummary.tenantId, ctx.tenantId), eq(accountSummary.accountId, accountId)));
}

/**
 * A merge moves the merged account's conflicts to the survivor (a collapsed person's to the person they became).
 * An open conflict on a key the survivor already has open joins it. Recounts both summaries. The caller holds
 * both account locks.
 */
export async function moveConflicts(
  ctx: ModuleContext,
  survivorId: string,
  mergedId: string,
  collapsed: { id: string; into: string }[],
): Promise<void> {
  const into = new Map(collapsed.map((c) => [c.id, c.into]));
  const theirs = await ctx.tx.select().from(conflict).where(and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.accountId, mergedId)));
  for (const c of theirs) {
    const personId = c.personId ? (into.get(c.personId) ?? c.personId) : null;
    const [mine] =
      c.status === 'open'
        ? await ctx.tx
            .select()
            .from(conflict)
            .where(
              and(
                eq(conflict.tenantId, ctx.tenantId),
                eq(conflict.accountId, survivorId),
                sql`coalesce(${conflict.personId}, '') = ${personId ?? ''}`,
                eq(conflict.key, c.key),
                eq(conflict.status, 'open'),
              ),
            )
        : [];
    if (mine) {
      const factIds = [...mine.factIds, ...c.factIds.filter((id) => !mine.factIds.includes(id))];
      await ctx.tx.update(conflict).set({ factIds }).where(and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.id, mine.id)));
      await ctx.tx.delete(conflict).where(and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.id, c.id)));
    } else {
      await ctx.tx.update(conflict).set({ accountId: survivorId, personId }).where(and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.id, c.id)));
    }
  }
  await recountOpenConflicts(ctx, survivorId);
  await recountOpenConflicts(ctx, mergedId);
}
