import type { QueueFilters } from '@/modules/routing';
import { parseIsoParam } from '../_lib/iso-date';

/** The queue's query string: `status` may repeat or be comma separated. */
export function queueFilters(url: URL): QueueFilters {
  const q = url.searchParams;
  const statusKeys = q.getAll('status').flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  return {
    statusKeys: statusKeys.length > 0 ? statusKeys : undefined,
    practiceId: q.get('practice_id') || undefined,
    offerId: q.get('offer_id') || undefined,
    sourceId: q.get('source_id') || undefined,
    batchId: q.get('batch_id') || undefined,
    tier: q.get('tier') || undefined,
    flag: q.get('flag') || undefined,
    arrivedSince: parseIsoParam(q.get('arrived_since'), 'arrived_since'),
  };
}
