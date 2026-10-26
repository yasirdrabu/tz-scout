import type { ModuleContext } from '../context';
import { outbox } from '../db/schema';
import { newId } from '../ids';
import { eventSubject, jobSubject } from '../nats/subjects';
import type { Envelope } from './envelope';
import type { EventDef, JobDef } from './registry';

/** Validates `data` and inserts the event into the outbox inside `ctx.tx`. */
export async function publish<D>(
  ctx: ModuleContext,
  def: EventDef<D>,
  data: D,
  subject?: { type: string; id: string },
): Promise<Envelope<D>> {
  const parsed = def.data.parse(data);
  const envelope: Envelope<D> = {
    id: newId('evt'),
    type: def.type,
    schemaVersion: def.schemaVersion,
    tenantId: ctx.tenantId,
    occurredAt: new Date().toISOString(),
    actor: ctx.actor,
    correlationId: ctx.correlationId,
    ...(ctx.causationId ? { causationId: ctx.causationId } : {}),
    ...(subject ? { subject } : {}),
    data: parsed,
  };
  await ctx.tx.insert(outbox).values({
    id: envelope.id,
    tenantId: ctx.tenantId,
    kind: 'event',
    natsSubject: eventSubject(ctx.tenantId, def.type),
    payload: envelope,
  });
  return envelope;
}

/** Validates `data` and inserts a job message into the outbox inside `ctx.tx`. Returns the job id. */
export async function enqueueJob<D>(ctx: ModuleContext, def: JobDef<D>, data: D): Promise<string> {
  const parsed = def.data.parse(data);
  const id = newId('job');
  const envelope: Envelope<D> = {
    id,
    type: `jobs.${def.name}`,
    schemaVersion: 1,
    tenantId: ctx.tenantId,
    occurredAt: new Date().toISOString(),
    actor: ctx.actor,
    correlationId: ctx.correlationId,
    ...(ctx.causationId ? { causationId: ctx.causationId } : {}),
    data: parsed,
  };
  await ctx.tx.insert(outbox).values({
    id,
    tenantId: ctx.tenantId,
    kind: 'job',
    natsSubject: jobSubject(ctx.tenantId, def.name),
    payload: envelope,
  });
  return id;
}
