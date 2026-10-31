import { archiveCaseStudy, updateCaseStudy } from '@/modules/offers';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';
import { patchCaseStudyBody } from '../schemas';

export const PATCH = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'case-studies');
  if (action) throw notFound();
  return updateCaseStudy(ctx, id, await parseBody(req, patchCaseStudyBody));
});

// POST /api/v1/case-studies/{id}:archive
export const POST = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'case-studies');
  if (action !== 'archive') throw notFound();
  return archiveCaseStudy(ctx, id);
});
