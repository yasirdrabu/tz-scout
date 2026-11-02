import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import type { RescoreFilter } from '../contracts/jobs';
import type { ScoreCause } from '../contracts/types';
import { rescoreRun, rescoreRunPart } from '../db/schema';

const DAY_MS = 86_400_000;
/** A run whose pages are all listed and that has counted nothing for this long has a message that will not finish. */
const STALLED_MS = 15 * 60_000;

export type RescoreRunView = {
  id: string;
  cause: string;
  total: number;
  done: number;
  startedAt: Date;
  finishedAt: Date | null;
  /** Unfinished, every page listed, and nothing counted for 15 minutes: the banner stops showing it as running. */
  stalled: boolean;
};

/** Records a new rescore run with nothing counted yet. Returns its id. */
export async function createRun(ctx: ModuleContext, filter: RescoreFilter, cause: ScoreCause): Promise<string> {
  const id = newId('rsr');
  await ctx.tx.insert(rescoreRun).values({
    id,
    tenantId: ctx.tenantId,
    cause,
    filter,
    requestedBy: ctx.actor.kind === 'user' ? ctx.actor.id : null,
  });
  return id;
}

/**
 * Claims `partKey` (one page or accounts message) for the run, in the caller's transaction. False when it was
 * already counted, so a message delivered again adds nothing (Review Focus 5).
 */
async function claim(ctx: ModuleContext, runId: string, partKey: string): Promise<boolean> {
  const rows = await ctx.tx.insert(rescoreRunPart).values({ tenantId: ctx.tenantId, runId, partKey }).onConflictDoNothing().returning();
  return rows.length > 0;
}

/** Sets `finished_at` once: when the last page is listed and every account it found is counted. */
async function finishIfDone(ctx: ModuleContext, runId: string): Promise<void> {
  await ctx.tx
    .update(rescoreRun)
    .set({ finishedAt: sql`now()` })
    .where(
      and(
        eq(rescoreRun.tenantId, ctx.tenantId),
        eq(rescoreRun.id, runId),
        sql`${rescoreRun.finishedAt} is null and ${rescoreRun.pagingDone} and ${rescoreRun.done} >= ${rescoreRun.total}`,
      ),
    );
}

/** A page listed `found` accounts; `last` when no page follows. */
export async function countPage(ctx: ModuleContext, runId: string, partKey: string, found: number, last: boolean): Promise<void> {
  if (!(await claim(ctx, runId, `page:${partKey}`))) return;
  await ctx.tx
    .update(rescoreRun)
    .set({ total: sql`${rescoreRun.total} + ${found}`, updatedAt: sql`now()`, ...(last ? { pagingDone: true } : {}) })
    .where(and(eq(rescoreRun.tenantId, ctx.tenantId), eq(rescoreRun.id, runId)));
  await finishIfDone(ctx, runId);
}

/** An accounts message scored (or skipped as gone) `processed` of its accounts. */
export async function countAccounts(ctx: ModuleContext, runId: string, partKey: string, processed: number): Promise<void> {
  if (!(await claim(ctx, runId, `accounts:${partKey}`))) return;
  await ctx.tx
    .update(rescoreRun)
    .set({ done: sql`${rescoreRun.done} + ${processed}`, updatedAt: sql`now()` })
    .where(and(eq(rescoreRun.tenantId, ctx.tenantId), eq(rescoreRun.id, runId)));
  await finishIfDone(ctx, runId);
}

/** The queue banner's progress (Ruling 12): the newest run started in the last 24 hours, whatever started it, or null. */
export async function latestRescore(ctx: ModuleContext, now: Date = new Date()): Promise<RescoreRunView | null> {
  const [run] = await ctx.tx
    .select({
      id: rescoreRun.id,
      cause: rescoreRun.cause,
      total: rescoreRun.total,
      done: rescoreRun.done,
      startedAt: rescoreRun.startedAt,
      finishedAt: rescoreRun.finishedAt,
      pagingDone: rescoreRun.pagingDone,
      updatedAt: rescoreRun.updatedAt,
    })
    .from(rescoreRun)
    .where(and(eq(rescoreRun.tenantId, ctx.tenantId), gte(rescoreRun.startedAt, new Date(now.getTime() - DAY_MS))))
    .orderBy(desc(rescoreRun.startedAt), desc(rescoreRun.id))
    .limit(1);
  if (!run) return null;
  const { pagingDone, updatedAt, ...view } = run;
  return { ...view, stalled: pagingDone && !run.finishedAt && now.getTime() - updatedAt.getTime() > STALLED_MS };
}
