import { listFeedback } from '@/modules/intake';
import { parseIsoParam } from '../_lib/iso-date';
import { pageLimit } from '../_lib/pagination';
import { v1Route } from '../_lib/v1-route';

export const dynamic = 'force-dynamic';

/** SRC-E1-S4-AC2: what the principal's own source (and the sources below it) was told about its arrivals, newest first. */
export const GET = v1Route({ permission: 'arrivals:read' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  const since = parseIsoParam(url.searchParams.get('since'), 'since');
  return listFeedback(ctx, { since, cursor: url.searchParams.get('cursor') || undefined, limit: pageLimit(url) });
});
