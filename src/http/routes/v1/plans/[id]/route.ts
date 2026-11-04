import { z } from 'zod';
import { abandonPlan, completePlan, pausePlan, resumePlan, type PlanView } from '@/modules/playbooks';
import type { ModuleContext } from '@/platform/context';
import { parseBody } from '../../_lib/body';
import { idAndAction } from '../../_lib/path';
import { byAction, v1Route } from '../../_lib/v1-route';

const abandonBody = z.strictObject({ reason: z.string().max(500, 'Keep this under 500 characters.').optional() });

const plan = (run: (ctx: ModuleContext, id: string) => Promise<PlanView>) =>
  v1Route({ permission: 'playbooks:write', peopleOnly: true }, async (req, _principal, ctx) => run(ctx, idAndAction(req, 'plans').id));

// POST /api/v1/plans/{id}:pause, :resume, :complete and :abandon (people only). A plan on an account the caller cannot see is a 404.
export const POST = byAction('plans', {
  pause: plan(pausePlan),
  resume: plan(resumePlan),
  complete: plan(completePlan),
  abandon: v1Route({ permission: 'playbooks:write', peopleOnly: true }, async (req, _principal, ctx) => {
    const body = await parseBody<{ reason?: string }>(req, abandonBody);
    return abandonPlan(ctx, idAndAction(req, 'plans').id, body.reason);
  }),
});
