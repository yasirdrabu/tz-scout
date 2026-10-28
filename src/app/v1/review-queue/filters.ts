import type { QueueFilters } from '@/modules/routing';
import { ScoutError } from '@/platform/errors';

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/;

/** `arrived_since`: an ISO date (start of that day, UTC) or datetime with an offset. */
function arrivedSince(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (!ISO.test(raw) || Number.isNaN(d.getTime())) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Check the request.', errors: [{ path: 'arrived_since', message: 'Use a date like 2026-10-01 or a date and time like 2026-10-01T09:00:00Z.' }] });
  }
  return d;
}

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
    arrivedSince: arrivedSince(q.get('arrived_since')),
  };
}
