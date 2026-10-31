import { runsSummary } from '@/modules/ai-tasks';
import { listTenants } from '@/modules/tenancy';
import { listDeadJobs } from '@/platform/dead-jobs';
import { systemHealth } from '@/platform/health';
import { scrubError } from '@/platform/scrub-error';
import { adminRoute } from '../../_lib/v1-route';

/**
 * The System health screen in one call: relay lag, pending work per queue (NATS consumer) with the
 * oldest message's age, dead jobs (the newest 100 and the total), schedules and AI spend today (UTC).
 * When NATS does not answer, `queues_available` is false and `queues` is empty; the rest is current.
 */
export const GET = adminRoute({}, async (_req, _person, { tx }) => {
  const [health, dead, tenants, ai] = await Promise.all([systemHealth({ tx }), listDeadJobs({ limit: 100, tx }), listTenants(tx), runsSummary(tx)]);
  const names = new Map(tenants.map((t) => [t.id, t.name]));
  const tenantName = (id: string) => names.get(id) ?? null;
  return {
    relayLagMs: health.relayLagMs,
    queuesAvailable: health.consumersAvailable,
    pendingTotal: health.consumers.reduce((n, c) => n + c.pending + c.ackPending, 0),
    queues: health.consumers,
    deadJobCount: health.deadJobs,
    deadJobs: dead.map((d) => ({ ...d, tenantName: tenantName(d.tenantId), lastError: scrubError(d.lastError) })),
    schedules: health.schedules.map((s) => ({ ...s, tenantName: tenantName(s.tenantId) })),
    aiSpendTodayCents: ai.spendTodayCents,
  };
});
