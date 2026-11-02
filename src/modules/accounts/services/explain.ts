import { and, eq, inArray, sql } from 'drizzle-orm';
import { runTask } from '@/modules/ai-tasks';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { factLabel } from '../contracts/fact-labels';
import { sourceInfoProvider } from '../contracts/ports';
import { conflict, fact } from '../db/schema';
import { conflictExplanationTask } from '../tasks/conflict-explanation';

/**
 * Asks Claude why the conflict's values may differ and stores the sentence (Ruling 9). It reads the conflict as it is
 * now: a merged-away or resolved conflict is skipped, and a conflict that gained a fact meanwhile keeps the sentence
 * out (the change queued another run). Only a live answer is stored; mock and rules runs, and a missing Claude, leave
 * the explanation empty.
 */
export async function explainConflict(ctx: ModuleContext, conflictId: string): Promise<void> {
  const [c] = await ctx.tx.select().from(conflict).where(and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.id, conflictId)));
  if (!c || c.status !== 'open') return;
  const rows = await ctx.tx.select().from(fact).where(and(eq(fact.tenantId, ctx.tenantId), inArray(fact.id, c.factIds)));
  if (rows.length < 2) return;
  const closest = (f: (typeof rows)[number]) => f.agentSourceId ?? f.vendorSourceId ?? f.personSourceId;
  const ids = [...new Set(rows.map(closest).filter((s): s is string => !!s))];
  const names = await sourceInfoProvider().sourceNames(ctx, ids);
  const input = {
    key: c.key,
    label: factLabel(c.key),
    facts: rows.map((f) => ({
      id: f.id,
      value: f.value,
      observedAt: f.observedAt.toISOString(),
      sourceName: names.get(closest(f) ?? '') ?? null,
      url: f.url,
      note: f.note,
    })),
  };
  let result;
  try {
    result = await runTask(ctx, conflictExplanationTask, input, { subject: { type: 'conflict', id: c.id } });
  } catch (e) {
    if (e instanceof ScoutError && e.slug === 'ai_unavailable') return;
    throw e;
  }
  if (result.mode !== 'live') return;
  const factIds = result.output.fact_ids.filter((id) => c.factIds.includes(id));
  // The where clause keeps a sentence out when the conflict was resolved or gained a fact while Claude answered.
  await ctx.tx
    .update(conflict)
    .set({ explanation: result.output.explanation, explanationFactIds: factIds })
    .where(and(eq(conflict.tenantId, ctx.tenantId), eq(conflict.id, c.id), eq(conflict.status, 'open'), sql`${conflict.factIds} = array[${sql.join(c.factIds.map((id) => sql`${id}`), sql`, `)}]::text[]`));
}
