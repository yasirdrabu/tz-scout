import { archivePractice, getPractice, practiceViews, updatePractice } from '@/modules/offers';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';
import { patchPracticeBody } from '../schemas';

/** One practice, with its lead's name and offer count (a deep link to the practice view). */
export const GET = v1Route({ permission: 'offers:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'practices');
  if (action) throw notFound();
  return getPractice(ctx, id);
});

export const PATCH = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'practices');
  if (action) throw notFound();
  return (await practiceViews(ctx, [await updatePractice(ctx, id, await parseBody(req, patchPracticeBody))]))[0]!;
});

// POST /api/v1/practices/{id}:archive
export const POST = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'practices');
  if (action !== 'archive') throw notFound();
  return (await practiceViews(ctx, [await archivePractice(ctx, id)]))[0]!;
});
