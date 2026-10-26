// Background jobs on pg-boss (Postgres). If the queue can't start, jobs run in-process after the
// requested delay so local dev never silently drops work.

import type PgBossType from "pg-boss";

export const QUEUES = {
  leadValidate: "lead-validate",
  batchCollect: "batch-collect",
  touchesTick: "touches-tick",
  scorecardWeekly: "scorecard-weekly",
  conversionsSync: "conversions-sync",
  buyersSearch: "buyers-search",
  buyersRematch: "buyers-rematch",
  buyersScheduled: "buyers-scheduled",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

type Handler = (data: Record<string, unknown>) => Promise<void>;

const g = globalThis as unknown as { __boss?: Promise<PgBossType | null>; __handlers?: Map<string, Handler> };
g.__handlers ??= new Map();

export function registerHandler(name: QueueName, h: Handler) {
  g.__handlers!.set(name, h);
}

export async function getBoss(): Promise<PgBossType | null> {
  if (process.env.JOBS_DISABLED === "true") return null;
  g.__boss ??= (async () => {
    try {
      const { default: PgBoss } = await import("pg-boss");
      const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema: "pgboss" });
      boss.on("error", (e) => console.error("[jobs]", e.message));
      await boss.start();
      for (const q of Object.values(QUEUES)) await boss.createQueue(q).catch(() => {});
      return boss;
    } catch (e) {
      console.error("[jobs] queue unavailable, running jobs in-process:", (e as Error).message);
      return null;
    }
  })();
  return g.__boss;
}

export async function enqueue(name: QueueName, data: Record<string, unknown>, opts: { startAfterSeconds?: number; singletonKey?: string } = {}) {
  const boss = await getBoss();
  if (boss) {
    await boss.send(name, data, { startAfter: opts.startAfterSeconds ?? 0, singletonKey: opts.singletonKey, retryLimit: 3, retryDelay: 10 });
    return;
  }
  const h = g.__handlers!.get(name);
  if (!h) {
    // Jobs are off in this process (seed, tests, scripts). The caller drives the work itself.
    if (process.env.JOBS_DISABLED !== "true") console.warn(`[jobs] no worker for ${name}; job skipped`);
    return;
  }
  setTimeout(() => h(data).catch((e) => console.error(`[jobs] ${name} failed:`, e)), (opts.startAfterSeconds ?? 0) * 1000);
}
