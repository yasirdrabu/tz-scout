import type { ModuleContext } from '../context';
import type { Envelope } from '../events/envelope';
import type { JobDef } from '../events/registry';

/** Retry schedule from architecture/events-and-async.md: 5s, 30s, 2m, 10m, 1h. */
export const DEFAULT_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000];
export const DEFAULT_MAX_DELIVER = 6;
export const DEFAULT_TIMEOUT_MS = 60_000;

export type JobHandlerDef<D = unknown> = {
  kind: 'job';
  /** The job name, e.g. `platform.ping`. */
  name: string;
  job: JobDef<D>;
  // Method syntax on purpose: a JobHandlerDef<X> must fit in a JobHandlerDef[] list.
  handle(e: Envelope<D>, ctx: ModuleContext): Promise<void>;
};

export function defineJobHandler<D>(
  job: JobDef<D>,
  handle: (e: Envelope<D>, ctx: ModuleContext) => Promise<void>,
): JobHandlerDef<D> {
  return { kind: 'job', name: job.name, job, handle };
}

/** Delay before the next delivery after attempt number `deliveryCount` (1-based) failed. */
export function backoffFor(backoffMs: number[], deliveryCount: number): number {
  if (backoffMs.length === 0) return 0;
  return backoffMs[Math.min(deliveryCount, backoffMs.length) - 1] as number;
}
