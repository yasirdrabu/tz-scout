import { sourceStatsFromJourneys } from '@/modules/analytics';
import { listSources } from '@/modules/intake';
import { stageNames } from '@/modules/routing';
import { can } from '@/modules/tenancy';
import { v1Route } from '../../_lib/v1-route';

/**
 * Sent, Reviewed, Assigned and Won per source the caller can see, for all time, each account under the source that
 * first sent it at the furthest stage it reached, children rolled up (R3b-1 Ruling 13), with the percentages, where
 * the accounts went in the workspace's stage order with each name, and all-time spend and cost per won (null
 * without `costs:read`). Over the accounts the caller can see. Intake lists the sources; analytics counts them.
 */
export const GET = v1Route({ permission: 'sources:manage' }, async (_req, principal, ctx) => {
  const ids = (await listSources(ctx, { statuses: ['active', 'paused', 'archived'] })).map((s) => s.id);
  const stats = await sourceStatsFromJourneys(ctx, ids, { spend: can(principal, 'costs:read') });
  const names = await stageNames(ctx);
  return {
    data: ids.map((sourceId) => {
      const s = stats.get(sourceId)!;
      return { sourceId, ...s, byStage: s.byStage.map((b) => ({ key: b.key, label: names.get(b.key) ?? b.key, count: b.count })) };
    }),
  };
});
