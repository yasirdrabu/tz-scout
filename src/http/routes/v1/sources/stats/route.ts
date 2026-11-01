import { listSources, sourceStats } from '@/modules/intake';
import { STAGE_LABELS, type Stage } from '@/modules/routing';
import { v1Route } from '../../_lib/v1-route';

/**
 * Sent, Reviewed, Assigned and Won per source the caller can see, children rolled up (Ruling 4), with the
 * percentages and every stage's count in the API's order with its label. Over the accounts the caller can see.
 */
export const GET = v1Route({ permission: 'sources:manage' }, async (_req, _principal, ctx) => {
  const ids = (await listSources(ctx, { statuses: ['active', 'paused', 'archived'] })).map((s) => s.id);
  const stats = await sourceStats(ctx, ids);
  return {
    data: ids.map((sourceId) => {
      const s = stats.get(sourceId)!;
      return { sourceId, ...s, byStage: s.byStage.map((b) => ({ key: b.key, label: STAGE_LABELS[b.key as Stage] ?? b.key, count: b.count })) };
    }),
  };
});
