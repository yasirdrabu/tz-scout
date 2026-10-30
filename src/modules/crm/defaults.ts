import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import { upsertSchedule } from '@/platform/scheduler';
import { activityPollJob, dealsPollJob, ownersSyncJob } from './contracts/jobs';
import { DEFAULT_FOLLOW_UP_DAYS } from './contracts/types';
import { crmSetting, fieldMapping } from './db/schema';

const TIER_LABELS = { act_now: 'Act now', good_fit: 'Good fit', watch: 'Watch', not_fit: 'Not a fit' };

type Transform = 'none' | 'date' | 'enum_map';

/** The HubSpot company properties Scout fills in. The `taazaa_*` names are v1's, so v1 properties map unchanged (Ruling 10). */
export const DEFAULT_FIELD_MAPPINGS: readonly { scoutField: string; crmProperty: string; transform: Transform; transformConfig?: Record<string, string> }[] = [
  { scoutField: 'practice', crmProperty: 'taazaa_bucket', transform: 'none' },
  { scoutField: 'best_offer', crmProperty: 'taazaa_best_offer', transform: 'none' },
  { scoutField: 'tier', crmProperty: 'taazaa_tier', transform: 'enum_map', transformConfig: TIER_LABELS },
  { scoutField: 'fit', crmProperty: 'taazaa_fit_score', transform: 'none' },
  { scoutField: 'intent', crmProperty: 'taazaa_signal_score', transform: 'none' },
  { scoutField: 'priority', crmProperty: 'taazaa_total_score', transform: 'none' },
  { scoutField: 'why_now', crmProperty: 'taazaa_why_now', transform: 'none' },
  { scoutField: 'top_signals', crmProperty: 'taazaa_top_signals', transform: 'none' },
  { scoutField: 'research_topics', crmProperty: 'taazaa_research_topics', transform: 'none' },
  { scoutField: 'last_handoff', crmProperty: 'taazaa_last_pushed', transform: 'date' },
  { scoutField: 'scout_link', crmProperty: 'scout_link', transform: 'none' },
];

/** Polls are fixed in R1c (Ruling 17): activity every 15 minutes, deals hourly, owners daily at 05:00 UTC. */
export const CRM_SCHEDULES = [
  { job: activityPollJob.name, cron: '*/15 * * * *' },
  { job: dealsPollJob.name, cron: '0 * * * *' },
  { job: ownersSyncJob.name, cron: '0 5 * * *' },
] as const;

/** Adds what is missing and leaves changed rows alone, so it is safe to run again. */
export async function seedCrmDefaults(ctx: ModuleContext): Promise<void> {
  const tenantId = ctx.tenantId;
  await ctx.tx.insert(crmSetting).values({ tenantId, system: 'hubspot', followUpDays: DEFAULT_FOLLOW_UP_DAYS }).onConflictDoNothing();
  await ctx.tx
    .insert(fieldMapping)
    .values(
      DEFAULT_FIELD_MAPPINGS.map((m) => ({
        id: newId('fmp'),
        tenantId,
        system: 'hubspot',
        scoutField: m.scoutField,
        crmObject: 'company',
        crmProperty: m.crmProperty,
        direction: 'push',
        transform: m.transform,
        transformConfig: m.transformConfig ?? null,
      })),
    )
    .onConflictDoNothing();
  for (const s of CRM_SCHEDULES) {
    await upsertSchedule({ actor: ctx.actor, correlationId: ctx.correlationId }, { tenantId, jobName: s.job, cron: s.cron, timezone: 'UTC', payload: {} });
  }
}
