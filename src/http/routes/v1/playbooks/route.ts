import { z } from 'zod';
import { createTemplate, listTemplates, TEMPLATE_STATUSES, type TemplateInput } from '@/modules/playbooks';
import { ScoutError } from '@/platform/errors';
import { parseBody } from '../_lib/body';
import { pageOfList } from '../_lib/pagination';
import { created, v1Route } from '../_lib/v1-route';
import { createTemplateBody, templateOut, withSteps } from './schemas';

const statusParam = z.enum(TEMPLATE_STATUSES);

// The list carries `steps` as a count, plus `days`, `channels`, `runs_on` and `running`.
export const GET = v1Route({ permission: 'playbooks:read' }, async (req, _principal, ctx) => {
  const asked = new URL(req.url).searchParams.get('status');
  const parsed = asked === null ? null : statusParam.safeParse(asked);
  if (parsed && !parsed.success) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Check the request.', errors: [{ path: 'status', message: 'Use draft, active or archived.' }] });
  }
  return pageOfList(req, (await listTemplates(ctx, { status: parsed?.data })).map(templateOut));
});

export const POST = v1Route({ permission: 'playbooks:manage' }, async (req, _principal, ctx) => {
  const input = withSteps(await parseBody<TemplateInput & { steps?: never }>(req, createTemplateBody));
  return created(templateOut(await createTemplate(ctx, input as TemplateInput)));
});
