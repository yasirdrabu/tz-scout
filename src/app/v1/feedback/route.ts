import { listFeedback } from '@/modules/intake';
import { ScoutError } from '@/platform/errors';
import { pageLimit } from '../_lib/pagination';
import { v1Route } from '../_lib/v1-route';

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/;

export const dynamic = 'force-dynamic';

/** SRC-E1-S4-AC2: what the principal's own source (and the sources below it) was told about its arrivals, newest first. */
export const GET = v1Route({ permission: 'arrivals:read' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw === null ? undefined : new Date(sinceRaw);
  if (sinceRaw !== null && (!ISO.test(sinceRaw) || Number.isNaN(since!.getTime()))) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Check the request.', errors: [{ path: 'since', message: 'Use a date like 2026-10-01 or a date and time like 2026-10-01T09:00:00Z.' }] });
  }
  return listFeedback(ctx, { since, cursor: url.searchParams.get('cursor') || undefined, limit: pageLimit(url) });
});
