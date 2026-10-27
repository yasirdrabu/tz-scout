import { archivePractice, updatePractice } from '@/modules/offers';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';
import { patchPracticeBody } from '../schemas';

export const dynamic = 'force-dynamic';

export const PATCH = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'practices');
  if (action) throw notFound();
  return updatePractice(ctx, id, await parseBody(req, patchPracticeBody));
});

// POST /v1/practices/{id}:archive
export const POST = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'practices');
  if (action !== 'archive') throw notFound();
  return archivePractice(ctx, id);
});
