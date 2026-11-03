import type { ModuleContext } from '@/platform/context';
import { ensureSchedule } from '@/platform/scheduler';
import { expireRequestsJob } from './contracts/jobs';

/** Daily at 04:00 UTC, the expiry of requests flagged for 14 days (Ruling 7). */
export const EXPIRE_CRON = '0 4 * * *';

/**
 * A tenant's enrichment defaults: the expiry schedule, made when missing (an unlocked check, so creates don't
 * serialize on the row or audit each time). Run whenever a request is created, so
 * workspaces made before enrichment need no back-fill (Ruling 7).
 */
export async function seedEnrichmentDefaults(ctx: ModuleContext): Promise<void> {
  await ensureSchedule(
    { actor: ctx.actor, correlationId: ctx.correlationId, tx: ctx.tx },
    { tenantId: ctx.tenantId, jobName: expireRequestsJob.name, cron: EXPIRE_CRON, timezone: 'UTC', payload: {} },
  );
}
