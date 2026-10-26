import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ModuleContext } from './context';
import { adminDb } from './db/client';
import { pingResult as pingResultTable } from './db/schema';
import { enqueueJob } from './events/outbox';
import { defineJob } from './events/registry';
import { defineJobHandler } from './runtime/jobs';

/** Round trip check: outbox, relay, NATS, worker, database. Used by Admin, System and the exit check. */
export const pingJob = defineJob('platform.ping', z.object({ sentAt: z.string().datetime() }), {
  maxDeliver: 3,
  backoffMs: [1000, 5000],
  timeoutMs: 10_000,
});

export const pingHandler = defineJobHandler(pingJob, async (e, ctx) => {
  await ctx.tx
    .insert(pingResultTable)
    .values({ id: e.id, tenantId: e.tenantId, sentAt: new Date(e.data.sentAt) })
    .onConflictDoNothing();
});

/** Enqueues a ping inside `ctx.tx`. Returns its id; read the result with `pingResult(id)` after commit. */
export function sendPing(ctx: ModuleContext): Promise<string> {
  return enqueueJob(ctx, pingJob, { sentAt: new Date().toISOString() });
}

/** The handled ping, or null while it has not arrived. */
export async function pingResult(id: string): Promise<{ sentAt: Date; handledAt: Date } | null> {
  const [row] = await adminDb
    .select({ sentAt: pingResultTable.sentAt, handledAt: pingResultTable.handledAt })
    .from(pingResultTable)
    .where(eq(pingResultTable.id, id));
  return row ?? null;
}
