import { search } from '@/modules/accounts';
import { pageLimit } from '../_lib/pagination';
import { v1Route } from '../_lib/v1-route';

export const dynamic = 'force-dynamic';

export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  const q = url.searchParams;
  return search(ctx, {
    text: q.get('q') ?? q.get('domain') ?? undefined,
    tier: q.get('tier') ?? undefined,
    practiceId: q.get('practice_id') ?? undefined,
    bestOfferId: q.get('offer_id') ?? undefined,
    stage: q.get('stage') ?? undefined,
    sourceId: q.get('source_id') ?? undefined,
    cursor: q.get('cursor') || undefined,
    limit: pageLimit(url),
  });
});
