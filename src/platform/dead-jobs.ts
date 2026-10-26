import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { scrubError } from '@/lib/scrub-error';
import { platformAudit } from './audit';
import { adminDb } from './db/client';
import { deadJob, outbox } from './db/schema';
import { ScoutError } from './errors';
import { EnvelopeSchema, type Actor, type Envelope } from './events/envelope';
import { publish } from './events/outbox';
import { defineEvent } from './events/registry';
import { newId } from './ids';
import { eventSubject, jobSubject } from './nats/subjects';

/** Published in the dead-letter transaction. Tenant = the failed envelope's tenant. */
export const jobDead = defineEvent(
  'platform.job.dead',
  1,
  z.object({ jobType: z.string(), error: z.string(), attempts: z.number().int() }),
);

/** A platform admin acting on dead jobs. Not tenant-scoped. */
export type AdminCtx = { actor: Actor; correlationId?: string };

export type DeadJobView = {
  id: string;
  tenantId: string;
  /** Job name (e.g. `platform.ping`) or consumer name. */
  name: string;
  lastError: string;
  attempts: number;
  deadAt: Date;
};

const JOB_PREFIX = 'jobs.';

/**
 * Stores a message that failed on its last delivery and publishes `platform.job.dead`, in one
 * transaction. Returns false and publishes nothing when the same envelope is already dead for
 * this consumer or job (unique index `dead_job_envelope_uq`): a dead-letter whose `term()` was
 * lost, or two workers giving up on the same message at once.
 */
export async function recordDeadJob(input: {
  name: string;
  envelope: Envelope;
  error: string;
  attempts: number;
}): Promise<boolean> {
  const { name, envelope, attempts } = input;
  const error = scrubError(input.error);
  return adminDb.transaction(async (tx) => {
    const inserted = await tx
      .insert(deadJob)
      .values({
        id: newId('dead'),
        tenantId: envelope.tenantId,
        consumerOrJob: name,
        envelope,
        lastError: error,
        attempts,
      })
      .onConflictDoNothing()
      .returning({ id: deadJob.id });
    if (inserted.length === 0) return false;
    await publish(
      {
        tenantId: envelope.tenantId,
        actor: { kind: 'system', id: 'system' },
        correlationId: envelope.correlationId,
        causationId: envelope.id,
        tx,
      },
      jobDead,
      { jobType: name, error, attempts },
    );
    return true;
  });
}

/** Dead jobs, newest first. */
export async function listDeadJobs(opts: { limit?: number } = {}): Promise<DeadJobView[]> {
  const rows = await adminDb
    .select()
    .from(deadJob)
    .orderBy(desc(deadJob.deadAt), desc(deadJob.id))
    .limit(opts.limit ?? 200);
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    name: r.consumerOrJob,
    lastError: r.lastError,
    attempts: r.attempts,
    deadAt: r.deadAt,
  }));
}

const notFound = (id: string) =>
  new ScoutError({ slug: 'not-found', status: 404, title: 'Dead job not found', detail: `No dead job ${id}` });

/**
 * Sends a dead message again and deletes the dead row.
 * - A job is re-enqueued with a new id and the same correlation id. Returns the new job id.
 * - An event (dead in one consumer) is re-sent with the same event id under a new message id:
 *   consumers that already handled it skip it through `processed_event`. Returns the event id.
 */
export async function retryDeadJob(adminCtx: AdminCtx, deadJobId: string): Promise<string> {
  return adminDb.transaction(async (tx) => {
    const [row] = await tx.select().from(deadJob).where(eq(deadJob.id, deadJobId)).for('update');
    if (!row) throw notFound(deadJobId);
    const original = EnvelopeSchema.parse(row.envelope) as Envelope;
    let sentId: string;
    if (original.type.startsWith(JOB_PREFIX)) {
      const envelope: Envelope = { ...original, id: newId('job'), occurredAt: new Date().toISOString() };
      await tx.insert(outbox).values({
        id: envelope.id,
        tenantId: envelope.tenantId,
        kind: 'job',
        natsSubject: jobSubject(envelope.tenantId, original.type.slice(JOB_PREFIX.length)),
        payload: envelope,
      });
      sentId = envelope.id;
    } else {
      await tx.insert(outbox).values({
        id: newId('evt'),
        tenantId: original.tenantId,
        kind: 'event',
        natsSubject: eventSubject(original.tenantId, original.type),
        payload: original,
      });
      sentId = original.id;
    }
    await tx.delete(deadJob).where(eq(deadJob.id, deadJobId));
    await platformAudit(
      {
        action: 'platform.dead_job.retried',
        actor: adminCtx.actor,
        correlationId: adminCtx.correlationId,
        subject: { type: 'dead_job', id: deadJobId },
        after: { tenantId: row.tenantId, name: row.consumerOrJob, attempts: row.attempts, sentId },
      },
      tx,
    );
    return sentId;
  });
}

/** Deletes a dead job without running it again. */
export async function discardDeadJob(adminCtx: AdminCtx, deadJobId: string): Promise<void> {
  await adminDb.transaction(async (tx) => {
    const [row] = await tx.delete(deadJob).where(eq(deadJob.id, deadJobId)).returning();
    if (!row) throw notFound(deadJobId);
    await platformAudit(
      {
        action: 'platform.dead_job.discarded',
        actor: adminCtx.actor,
        correlationId: adminCtx.correlationId,
        subject: { type: 'dead_job', id: deadJobId },
        after: { tenantId: row.tenantId, name: row.consumerOrJob, attempts: row.attempts, lastError: row.lastError },
      },
      tx,
    );
  });
}
