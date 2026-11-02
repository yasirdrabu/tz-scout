import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { consumers, jobs } from '@/entry/worker';
import { controlAdminDb, type Db } from '@/platform/db/client';
import { workspaceDb } from '@/platform/db/doors';
import { outbox } from '@/platform/db/schema';
import { EnvelopeSchema, type Envelope } from '@/platform/events/envelope';
import { deliverOnce } from '@/platform/runtime/worker';

const databaseOf = async (db: Db) => ((await db.execute<{ d: string }>(sql`select current_database() as d`))[0]!).d;

/**
 * The outboxes a tenant's messages are in (D35): the control plane's (tenancy events, `t_platform`
 * jobs) and its workspace database's; one when they are the same database.
 */
async function outboxesOf(tenantId: string): Promise<Db[]> {
  let workspace: Db;
  try {
    workspace = (await workspaceDb(tenantId)).admin;
  } catch {
    return [controlAdminDb]; // not open: only the control plane's
  }
  return (await databaseOf(workspace)) === (await databaseOf(controlAdminDb)) ? [controlAdminDb] : [controlAdminDb, workspace];
}

/**
 * Stands in for the relay and worker in tests: takes the tenant's unsent outbox rows, from each of its
 * outboxes in `seq` order (the control plane's first), runs each matching consumer and job handler
 * from `src/entry/worker.ts` through the worker's own processed_event guard, marks the rows sent,
 * and repeats until none are left (handlers may add more). Stops early when `until` returns true after
 * a round; throws when rows are still unsent after `maxRounds`. A handler error is thrown to the test.
 */
export async function runOutbox(
  tenantId: string,
  opts: { until?: () => Promise<boolean>; maxRounds?: number } = {},
): Promise<void> {
  const unsent = (db: Db) =>
    db.select().from(outbox).where(and(eq(outbox.tenantId, tenantId), isNull(outbox.sentAt))).orderBy(asc(outbox.seq));
  for (let round = 0; round < (opts.maxRounds ?? 10); round++) {
    let any = false;
    for (const db of await outboxesOf(tenantId)) {
      for (const row of await unsent(db)) {
        any = true;
        const envelope = EnvelopeSchema.parse(row.payload) as Envelope;
        for (const c of consumers) if (c.event.type === envelope.type) await deliverOnce(c, envelope);
        for (const j of jobs) if (`jobs.${j.name}` === envelope.type) await deliverOnce(j, envelope);
        await db.update(outbox).set({ sentAt: new Date() }).where(eq(outbox.id, row.id));
      }
    }
    if (!any) return;
    if (opts.until && (await opts.until())) return;
  }
  for (const db of await outboxesOf(tenantId)) {
    if ((await unsent(db)).length > 0) throw new Error(`runOutbox: rows still unsent after ${opts.maxRounds ?? 10} rounds`);
  }
}
