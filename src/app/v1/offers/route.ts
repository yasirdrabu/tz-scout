import { z } from 'zod';
import { createOffer, listOffers, type OfferInput } from '@/modules/offers';
import { can } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { parseBody } from '../_lib/body';
import { pageOfList } from '../_lib/pagination';
import { created, v1Route } from '../_lib/v1-route';
import { createOfferBody } from './schemas';

export const dynamic = 'force-dynamic';

const statusParam = z.enum(['draft', 'approved', 'archived']);

// Without `offers:manage` the list is approved offers only, whatever `status` asks for.
export const GET = v1Route({ permission: 'offers:read' }, async (req, principal, ctx) => {
  const q = new URL(req.url).searchParams;
  const asked = q.get('status');
  const parsed = asked === null ? null : statusParam.safeParse(asked);
  if (parsed && !parsed.success) {
    throw new ScoutError({
      slug: 'validation',
      status: 400,
      title: 'Check the request.',
      errors: [{ path: 'status', message: 'Use draft, approved or archived.' }],
    });
  }
  const status = can(principal, 'offers:manage') ? parsed?.data : 'approved';
  return pageOfList(req, await listOffers(ctx, { practiceId: q.get('practice_id') ?? undefined, status }));
});

export const POST = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) =>
  created(await createOffer(ctx, await parseBody<OfferInput>(req, createOfferBody))),
);
