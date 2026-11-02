import { listSources, sourceStats } from '@/modules/intake';
import { stageNames } from '@/modules/routing';
import { v1Route } from '../../_lib/v1-route';

/**
 * Sent, Reviewed, Assigned and Won per source the caller can see, children rolled up (Ruling 4), with the
 * percentages and every stage's count in the workspace's stage order with its name. Over the accounts the caller can see.
 */
export const GET = v1Route({ permission: 'sources:manage' }, async (_req, _principal, ctx) => {
  const ids = (await listSources(ctx, { statuses: ['active', 'paused', 'archived'] })).map((s) => s.id);
  const stats = await sourceStats(ctx, ids);
  const names = await stageNames(ctx);
  return {
    data: ids.map((sourceId) => {
      const s = stats.get(sourceId)!;
      return { sourceId, ...s, byStage: s.byStage.map((b) => ({ key: b.key, label: names.get(b.key) ?? b.key, count: b.count })) };
    }),
  };
});
