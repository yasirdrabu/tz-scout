import type { ModuleContext } from '../context';
import type { Envelope } from '../events/envelope';
import type { EventDef, JobOptions } from '../events/registry';

export type ConsumerDef<D = unknown> = {
  kind: 'consumer';
  /** Stable name. Stored in `platform.processed_event`; changing it means every event is new again. */
  name: string;
  event: EventDef<D>;
  /** Events with the same key never run at the same time (advisory lock in the consumer transaction). */
  // Method syntax on purpose: a ConsumerDef<X> must fit in a ConsumerDef[] list.
  orderedBy?(e: Envelope<D>): string;
  handle(e: Envelope<D>, ctx: ModuleContext): Promise<void>;
  /** Retries and ack timeout. Defaults as for jobs (see runtime/jobs.ts). */
  opts: JobOptions;
};

export function defineConsumer<D>(def: {
  name: string;
  event: EventDef<D>;
  orderedBy?: (e: Envelope<D>) => string;
  handle: (e: Envelope<D>, ctx: ModuleContext) => Promise<void>;
  maxDeliver?: number;
  backoffMs?: number[];
  timeoutMs?: number;
}): ConsumerDef<D> {
  if (!def.name.trim()) throw new Error('Consumer name is required');
  const { maxDeliver, backoffMs, timeoutMs, ...rest } = def;
  return { kind: 'consumer', ...rest, opts: { maxDeliver, backoffMs, timeoutMs } };
}

/** NATS names may not contain dots or wildcards: anything outside [A-Za-z0-9_-] becomes `_`. */
export function natsSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Durable JetStream consumer name for a consumer or job handler. Deterministic, so restarts reuse it. */
export function durableName(def: { kind: 'consumer' | 'job'; name: string }): string {
  return `${def.kind}_${natsSafe(def.name)}`;
}
