import type { ModuleContext } from '@/platform/context';
import { upsertSchedule } from '@/platform/scheduler';
import { ageingJob } from './contracts/jobs';
import { scoringProfile } from './db/schema';

/** The scoring defaults every tenant starts with (SCO-E1 to E3, SCO-E6). */
export const DEFAULT_PROFILE = {
  weights: { fit: 40, intent: 25, revenue: 15, trust: 20 },
  fitParts: { industry: 30, size: 25, revenue: 20, region: 10, buyer: 15 },
  halfLifeDays: 45,
  maxSignalAgeDays: 365,
  tierCutoffs: { actNow: 75, goodFit: 55, watch: 35 },
  warmIntroCap: 20,
  trustNeutral: 0.6,
  researchFloorDays: 180,
};

/** Adds the profile when missing and leaves a changed one alone, so it is safe to run again. */
export async function seedScoringDefaults(ctx: ModuleContext): Promise<void> {
  const tenantId = ctx.tenantId;
  await ctx.tx.insert(scoringProfile).values({ tenantId, ...DEFAULT_PROFILE }).onConflictDoNothing();
  // Signals fade with time, so rescore nightly at 02:00 UTC.
  await upsertSchedule(
    { actor: ctx.actor, correlationId: ctx.correlationId },
    { tenantId, jobName: ageingJob.name, cron: '0 2 * * *', timezone: 'UTC', payload: {} },
  );
}
