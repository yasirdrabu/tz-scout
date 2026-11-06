import { parsePeriod, type FunnelFilters } from '@/modules/analytics';

/** The funnel's cohort filters from `?period=&practice=&offer=&batch=` (R3b-1 Ruling 5). */
export function funnelFilters(req: Request): FunnelFilters {
  const q = new URL(req.url).searchParams;
  const param = (k: string) => q.get(k) || undefined;
  return {
    period: parsePeriod(q.get('period')),
    ...(param('practice') ? { practiceId: param('practice') } : {}),
    ...(param('offer') ? { offerId: param('offer') } : {}),
    ...(param('batch') ? { batchId: param('batch') } : {}),
  };
}
