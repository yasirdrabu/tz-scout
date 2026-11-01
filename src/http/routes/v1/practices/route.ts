import { createPractice, listPractices, type PracticeInput } from '@/modules/offers';
import { parseBody } from '../_lib/body';
import { pageOfList } from '../_lib/pagination';
import { created, v1Route } from '../_lib/v1-route';
import { createPracticeBody } from './schemas';

export const GET = v1Route({ permission: 'offers:read' }, async (req, _principal, ctx) => ({
  ...pageOfList(req, await listPractices(ctx)),
}));

export const POST = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) =>
  created(await createPractice(ctx, await parseBody<PracticeInput>(req, createPracticeBody))),
);
