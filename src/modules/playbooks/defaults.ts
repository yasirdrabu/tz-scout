import type { ModuleContext } from '@/platform/context';
import { upsertSchedule } from '@/platform/scheduler';
import { briefSweepJob } from './contracts/jobs';

/** Every 15 minutes, a sweep settles or queues again the drafts stuck in `drafting`. */
export const SWEEP_CRON = '*/15 * * * *';

/** A tenant's playbooks defaults: the sweep schedule. Safe to run again. */
export async function seedPlaybooksDefaults(ctx: ModuleContext): Promise<void> {
  await upsertSchedule({ actor: ctx.actor, correlationId: ctx.correlationId, tx: ctx.tx }, { tenantId: ctx.tenantId, jobName: briefSweepJob.name, cron: SWEEP_CRON, timezone: 'UTC', payload: {} });
}
