import { z } from 'zod';
import { addStep, MAX_NOTE, OWNER_ROLES, STEP_CHANNELS, type StepAdd } from '@/modules/playbooks';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { created, v1Route } from '../../../_lib/v1-route';

const text = (max: number) => z.string().max(max, `Keep this under ${max.toLocaleString('en-US')} characters.`);

const body = z.strictObject({
  day: z.number().int('Use a whole number of days.').min(0, 'Use a day from 0 to 365.').max(365, 'Use a day from 0 to 365.'),
  channel: z.enum(STEP_CHANNELS),
  owner_role: z.enum(OWNER_ROLES),
  title: z.string().min(1, 'Give the step a title.').max(200, 'Keep this under 200 characters.'),
  detail: text(MAX_NOTE).nullable().optional(),
  subject: text(300).nullable().optional(),
  body: text(10_000).nullable().optional(),
  target_buying_roles: z.array(z.string().min(1)).max(20).optional(),
  crm_task: z.boolean().optional(),
  owner_user_id: z.string().min(1).nullable().optional(),
});

/** Adds a step to an open plan (people only). Returns the whole plan, 201. */
export const POST = v1Route({ permission: 'playbooks:write', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'plans');
  if (action) throw notFound();
  return created(await addStep(ctx, id, await parseBody<StepAdd>(req, body)));
});
