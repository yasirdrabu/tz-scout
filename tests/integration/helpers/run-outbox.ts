import { and, asc, eq, isNull } from 'drizzle-orm';
import { consumers, jobs } from '@/entry/worker';
import { adminDb } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { EnvelopeSchema, type Envelope } from '@/platform/events/envelope';
import { deliverOnce } from '@/platform/runtime/worker';

/**
 * Stands in for the relay and worker in tests: takes the tenant's unsent outbox rows in `seq`
 * order, runs each matching consumer and job handler from `src/entry/worker.ts` through the
 * worker's own processed_event guard, marks the rows sent, and repeats until none are left
 * (handlers may add more). Stops early when `until` returns true after a round; throws when rows are
 * still unsent after `maxRounds`. A handler error is thrown to the test.
 */
export async function runOutbox(
  tenantId: string,
  opts: { until?: () => Promise<boolean>; maxRounds?: number } = {},
): Promise<void> {
  for (let round = 0; round < (opts.maxRounds ?? 10); round++) {
    const rows = await adminDb
      .select()
      .from(outbox)
      .where(and(eq(outbox.tenantId, tenantId), isNull(outbox.sentAt)))
      .orderBy(asc(outbox.seq));
    if (rows.length === 0) return;
    for (const row of rows) {
      const envelope = EnvelopeSchema.parse(row.payload) as Envelope;
      for (const c of consumers) if (c.event.type === envelope.type) await deliverOnce(c, envelope);
      for (const j of jobs) if (`jobs.${j.name}` === envelope.type) await deliverOnce(j, envelope);
      await adminDb.update(outbox).set({ sentAt: new Date() }).where(eq(outbox.seq, row.seq));
    }
    if (opts.until && (await opts.until())) return;
  }
  const left = await adminDb
    .select({ seq: outbox.seq })
    .from(outbox)
    .where(and(eq(outbox.tenantId, tenantId), isNull(outbox.sentAt)))
    .limit(1);
  if (left.length > 0) throw new Error(`runOutbox: rows still unsent after ${opts.maxRounds ?? 10} rounds`);
}
