import { createCaseStudy, listCaseStudies, type CaseStudyInput } from '@/modules/offers';
import { parseBody } from '../_lib/body';
import { created, v1Route } from '../_lib/v1-route';
import { createCaseStudyBody } from './schemas';

export const dynamic = 'force-dynamic';

// Agents (API keys and OAuth grants) only see case studies that may be quoted to buyers.
export const GET = v1Route({ permission: 'offers:read' }, async (_req, principal, ctx) => ({
  data: await listCaseStudies(ctx, { buyerVisibleOnly: principal.kind !== 'user' }),
}));

export const POST = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) =>
  created(await createCaseStudy(ctx, await parseBody<CaseStudyInput>(req, createCaseStudyBody))),
);
