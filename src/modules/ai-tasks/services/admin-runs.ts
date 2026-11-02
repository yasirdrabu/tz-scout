import { and, desc, eq, getTableColumns, gte, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { listWorkspaceDatabases } from '@/platform/db/doors';
import { aiRun } from '../db/schema';
import { rawStatuses, type RunStatus } from '../domain/run-status';
import type { AiRunRow } from '../runner';

/**
 * Every tenant's runs (Decision 24), for platform admins only. Runs are workspace data, so these read
 * each workspace database in turn (`listWorkspaceDatabases`, as `scout_admin`) and merge (D35).
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

type RunWithAt = AiRunRow & { atText: string; atMicros: string };

/** Up to `limit` runs, newest first, across every tenant. `atText` is `created_at` as Postgres text, for a cursor. */
export async function allRuns(f: AllRunsQuery): Promise<(AiRunRow & { atText: string })[]> {
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
  const rows: RunWithAt[] = [];
  for (const { admin } of await listWorkspaceDatabases()) {
    rows.push(
      ...(await admin
        .select({
          ...getTableColumns(aiRun),
          atText: sql<string>`${aiRun.createdAt}::text`,
          // Microseconds since the epoch, to merge databases in the same order Postgres sorts them.
          atMicros: sql<string>`(extract(epoch from ${aiRun.createdAt}) * 1000000)::bigint::text`,
        })
        .from(aiRun)
        .where(and(...conditions))
        .orderBy(desc(aiRun.createdAt), desc(aiRun.id))
        .limit(f.limit)),
    );
  }
  rows.sort((a, b) => {
    const at = BigInt(b.atMicros) - BigInt(a.atMicros);
    return at !== 0n ? (at > 0n ? 1 : -1) : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return rows.slice(0, f.limit).map(({ atMicros: _, ...r }) => r);
}

/** One run in any tenant. */
export async function anyRun(id: string): Promise<AiRunRow | undefined> {
  for (const { admin } of await listWorkspaceDatabases()) {
    const [row] = await admin.select().from(aiRun).where(eq(aiRun.id, id));
    if (row) return row;
  }
  return undefined;
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

/** Postgres `percentile_cont(0.5)`: nulls left out, the middle value or the mean of the two middle ones. */
function median(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = (v.length - 1) / 2;
  return (v[Math.floor(mid)]! + v[Math.ceil(mid)]!) / 2;
}

/**
 * The AI runs tiles, over today (UTC) across every tenant. Counts and spend are summed per database;
 * the medians need every duration, so today's (task, duration) pairs are read and the medians taken here.
 */
export async function runsSummary(): Promise<RunsSummary> {
  const today = sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`;
  const failed = rawStatuses('failed');
  let runs = 0;
  let failedToday = 0;
  let spend = 0;
  let failedLastHour = 0;
  const durations: { task: string; ms: number | null }[] = [];
  for (const { admin } of await listWorkspaceDatabases()) {
    const [t] = await admin
      .select({
        runs: sql<number>`(count(*) filter (where ${aiRun.createdAt} >= ${today}))::int`,
        failed: sql<number>`(count(*) filter (where ${aiRun.createdAt} >= ${today} and ${inArray(aiRun.status, failed)}))::int`,
        spend: sql<number>`coalesce(sum(${aiRun.costCents}) filter (where ${aiRun.createdAt} >= ${today}), 0)::int`,
        failedLastHour: sql<number>`(count(*) filter (where ${aiRun.createdAt} >= now() - interval '1 hour' and ${inArray(aiRun.status, failed)}))::int`,
      })
      .from(aiRun)
      .where(or(gte(aiRun.createdAt, today), gte(aiRun.createdAt, sql`now() - interval '1 hour'`)));
    runs += t?.runs ?? 0;
    failedToday += t?.failed ?? 0;
    spend += t?.spend ?? 0;
    failedLastHour += t?.failedLastHour ?? 0;
    durations.push(...(await admin.select({ task: aiRun.task, ms: aiRun.durationMs }).from(aiRun).where(gte(aiRun.createdAt, today))));
  }
  const byTask = new Map<string, (number | null)[]>();
  for (const d of durations) byTask.set(d.task, [...(byTask.get(d.task) ?? []), d.ms]);
  // As `order by median desc, task`: Postgres puts a null median first when sorting descending.
  const slowest = [...byTask].map(([task, ms]) => ({ task, m: median(ms) })).sort((a, b) => {
    if (a.m !== b.m) return a.m === null ? -1 : b.m === null ? 1 : b.m - a.m;
    return a.task < b.task ? -1 : a.task > b.task ? 1 : 0;
  })[0];
  const all = median(durations.map((d) => d.ms));
  return {
    runsToday: runs,
    failedPct: runs === 0 ? null : Math.round(((failedToday * 100) / runs) * 10) / 10,
    medianMs: all === null ? null : Math.round(all),
    slowestTask: slowest?.task ?? null,
    spendTodayCents: spend,
    failedLastHour,
  };
}
