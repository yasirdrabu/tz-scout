import { and, desc, eq, getTableColumns, gte, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Tx } from '@/platform/db/tenant';
import { aiRun } from '../db/schema';
import { rawStatuses, type RunStatus } from '../domain/run-status';
import type { AiRunRow } from '../runner';

/**
 * Every tenant's runs (Decision 24). These functions take the platform admin's `adminDb`
 * transaction (from `adminRoute`): they read across tenants, so they must never get a tenant one.
 */
export type AllRunsQuery = {
  /** Text in the run id, the task, or the subject (account) id. */
  q?: string;
  status?: RunStatus;
  task?: string;
  tenantId?: string;
  /** Rows strictly older than this (created at as Postgres text, so microseconds survive; id), newest first. */
  after?: { at: string; id: string };
  limit: number;
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Up to `limit` runs, newest first, across every tenant. `atText` is `created_at` as Postgres text, for a cursor. */
export async function allRuns(tx: Tx, f: AllRunsQuery): Promise<(AiRunRow & { atText: string })[]> {
  const text = f.q?.trim();
  const like = text ? `%${escapeLike(text)}%` : undefined;
  const conditions: (SQL | undefined)[] = [
    f.status ? inArray(aiRun.status, rawStatuses(f.status)) : undefined,
    f.task ? eq(aiRun.task, f.task) : undefined,
    f.tenantId ? eq(aiRun.tenantId, f.tenantId) : undefined,
    like
      ? or(ilike(aiRun.id, like), ilike(aiRun.task, like), ilike(sql`${aiRun.inputRef}->'subject'->>'id'`, like))
      : undefined,
    f.after ? sql`(${aiRun.createdAt}, ${aiRun.id}) < (${f.after.at}::timestamptz, ${f.after.id})` : undefined,
  ];
  return tx
    .select({ ...getTableColumns(aiRun), atText: sql<string>`${aiRun.createdAt}::text` })
    .from(aiRun)
    .where(and(...conditions))
    .orderBy(desc(aiRun.createdAt), desc(aiRun.id))
    .limit(f.limit);
}

/** One run in any tenant. */
export async function anyRun(tx: Tx, id: string): Promise<AiRunRow | undefined> {
  const [row] = await tx.select().from(aiRun).where(eq(aiRun.id, id));
  return row;
}

export type RunsSummary = {
  runsToday: number;
  /** Failed share of today's runs, 0 to 100 with one decimal; null with no runs today. */
  failedPct: number | null;
  medianMs: number | null;
  /** The task with the highest median time today. */
  slowestTask: string | null;
  spendTodayCents: number;
  failedLastHour: number;
};

/** The AI runs tiles, over today (UTC) across every tenant. */
export async function runsSummary(tx: Tx): Promise<RunsSummary> {
  const today = sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`;
  const [slowest] = await tx
    .select({ task: aiRun.task })
    .from(aiRun)
    .where(gte(aiRun.createdAt, today))
    .groupBy(aiRun.task)
    .orderBy(desc(sql`percentile_cont(0.5) within group (order by ${aiRun.durationMs})`), aiRun.task)
    .limit(1);
  const failed = rawStatuses('failed');
  const [t] = await tx
    .select({
      runs: sql<number>`(count(*) filter (where ${aiRun.createdAt} >= ${today}))::int`,
      failed: sql<number>`(count(*) filter (where ${aiRun.createdAt} >= ${today} and ${inArray(aiRun.status, failed)}))::int`,
      medianMs: sql<number | null>`percentile_cont(0.5) within group (order by ${aiRun.durationMs}) filter (where ${aiRun.createdAt} >= ${today})`,
      spend: sql<number>`coalesce(sum(${aiRun.costCents}) filter (where ${aiRun.createdAt} >= ${today}), 0)::int`,
      failedLastHour: sql<number>`(count(*) filter (where ${aiRun.createdAt} >= now() - interval '1 hour' and ${inArray(aiRun.status, failed)}))::int`,
    })
    .from(aiRun)
    .where(or(gte(aiRun.createdAt, today), gte(aiRun.createdAt, sql`now() - interval '1 hour'`)));
  const runs = t?.runs ?? 0;
  return {
    runsToday: runs,
    failedPct: runs === 0 ? null : Math.round(((t!.failed * 100) / runs) * 10) / 10,
    medianMs: t?.medianMs == null ? null : Math.round(Number(t.medianMs)),
    slowestTask: slowest?.task ?? null,
    spendTodayCents: t?.spend ?? 0,
    failedLastHour: t?.failedLastHour ?? 0,
  };
}
