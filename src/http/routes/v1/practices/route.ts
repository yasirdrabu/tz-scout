import { createPractice, listPracticeViews, practiceViews, type PracticeInput } from '@/modules/offers';
import { can } from '@/modules/tenancy';
import { parseBody } from '../_lib/body';
import { pageOfList } from '../_lib/pagination';
import { created, v1Route } from '../_lib/v1-route';
import { createPracticeBody } from './schemas';

// offer_count counts only the offers the caller is shown: active ones without offers:manage.
export const GET = v1Route({ permission: 'offers:read' }, async (req, principal, ctx) => ({
  ...pageOfList(req, await listPracticeViews(ctx, { activeOnly: !can(principal, 'offers:manage') })),
}));

export const POST = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) =>
  created((await practiceViews(ctx, [await createPractice(ctx, await parseBody<PracticeInput>(req, createPracticeBody))]))[0]!),
);
