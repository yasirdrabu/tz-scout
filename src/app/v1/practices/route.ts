import { createPractice, listPractices, type PracticeInput } from '@/modules/offers';
import { parseBody } from '../_lib/body';
import { created, v1Route } from '../_lib/v1-route';
import { createPracticeBody } from './schemas';

export const dynamic = 'force-dynamic';

export const GET = v1Route({ permission: 'offers:read' }, async (_req, _principal, ctx) => ({
  data: await listPractices(ctx),
}));

export const POST = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) =>
  created(await createPractice(ctx, await parseBody<PracticeInput>(req, createPracticeBody))),
);
