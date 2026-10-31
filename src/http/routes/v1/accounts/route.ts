import { search } from '@/modules/accounts';
import { normaliseDomain } from '@/modules/intake';
import { ScoutError } from '@/platform/errors';
import { pageLimit } from '../_lib/pagination';
import { v1Route } from '../_lib/v1-route';

export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  const q = url.searchParams;
  const asked = q.get('domain');
  const domain = asked ? normaliseDomain(asked) : undefined;
  if (domain === null) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Check the request.', errors: [{ path: 'domain', message: 'Use a domain like acme.com.' }] });
  }
  return search(ctx, {
    text: q.get('q') ?? undefined,
    domain,
    tier: q.get('tier') ?? undefined,
    practiceId: q.get('practice_id') ?? undefined,
    bestOfferId: q.get('offer_id') ?? undefined,
    stage: q.get('stage') ?? undefined,
    sourceId: q.get('source_id') ?? undefined,
    cursor: q.get('cursor') || undefined,
    limit: pageLimit(url),
  });
});
