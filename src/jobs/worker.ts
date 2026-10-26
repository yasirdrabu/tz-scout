// Registers job handlers and schedules. Started once per server process from instrumentation.ts.

import { scopedDb } from "@/lib/db";
import { collectResults } from "@/server/tests";
import { validateLead } from "@/server/leads";
import { sendDueTouches } from "@/server/meetings";
import { syncConversions, weeklyRunAllCompanies } from "@/server/scorecard";
import { rematchAll, runScheduledSearches, runSearch } from "@/server/buyers";
import { unscopedDb } from "@/lib/db";
import { enqueue, getBoss, QUEUES, registerHandler, type QueueName } from "./queue";

const handlers: Record<QueueName, (d: Record<string, unknown>) => Promise<void>> = {
  [QUEUES.leadValidate]: async (d) => {
    await validateLead(scopedDb(String(d.companyId)), String(d.companyId), String(d.leadId));
  },
  [QUEUES.batchCollect]: async (d) => {
    const companyId = String(d.companyId);
    const done = await collectResults(scopedDb(companyId), companyId, String(d.batchId));
    if (!done) await enqueue(QUEUES.batchCollect, d, { startAfterSeconds: 5 });
  },
  [QUEUES.touchesTick]: async () => {
    await sendDueTouches();
  },
  [QUEUES.scorecardWeekly]: async () => {
    await weeklyRunAllCompanies();
  },
  [QUEUES.buyersSearch]: async (d) => {
    await runSearch(scopedDb(String(d.companyId)), String(d.companyId), String(d.searchId));
  },
  [QUEUES.buyersRematch]: async (d) => {
    await rematchAll(scopedDb(String(d.companyId)), String(d.companyId));
  },
  [QUEUES.buyersScheduled]: async () => {
    await runScheduledSearches();
  },
  [QUEUES.conversionsSync]: async () => {
    for (const c of await unscopedDb.company.findMany({ select: { id: true } })) await syncConversions(scopedDb(c.id), c.id);
  },
};

const g = globalThis as unknown as { __workerStarted?: boolean; __tick?: NodeJS.Timeout };

export async function startWorker() {
  if (g.__workerStarted) return;
  g.__workerStarted = true;
  for (const [name, h] of Object.entries(handlers)) registerHandler(name as QueueName, h);
  const boss = await getBoss();
  if (!boss) {
    // In-process fallback for schedules.
    g.__tick = setInterval(() => sendDueTouches().catch(() => {}), 30_000);
    return;
  }
  for (const [name, h] of Object.entries(handlers)) {
    await boss.work(name, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await h((job.data ?? {}) as Record<string, unknown>);
    });
  }
  await boss.schedule(QUEUES.touchesTick, "* * * * *");
  await boss.schedule(QUEUES.scorecardWeekly, "0 11 * * 1"); // Mondays 11:00 UTC (7am Eastern)
  await boss.schedule(QUEUES.conversionsSync, "30 11 * * *");
  await boss.schedule(QUEUES.buyersScheduled, "0 10 * * *"); // daily 10:00 UTC; weekly pulls run Mondays
  console.log("[jobs] worker started");
}
