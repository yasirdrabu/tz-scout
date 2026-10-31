import { z } from 'zod';
import { getOffer, linkCaseStudy, listCaseStudies, unlinkCaseStudy } from '@/modules/offers';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

const body = z.strictObject({ case_study_ids: z.array(z.string()) });

// PUT /v1/offers/{id}/case-studies replaces the linked case studies with exactly these ids.
export const PUT = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'offers');
  if (action) throw notFound();
  const { caseStudyIds } = await parseBody<{ caseStudyIds: string[] }>(req, body);
  await getOffer(ctx, id);
  const wanted = new Set(caseStudyIds);
  const current = await listCaseStudies(ctx, { offerId: id, includeArchived: true });
  for (const c of current) if (!wanted.has(c.id)) await unlinkCaseStudy(ctx, id, c.id);
  for (const caseStudyId of wanted) await linkCaseStudy(ctx, id, caseStudyId);
  return { data: await listCaseStudies(ctx, { offerId: id, includeArchived: true }) };
});
