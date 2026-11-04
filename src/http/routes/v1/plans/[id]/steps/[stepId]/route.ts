import { z } from 'zod';
import { MAX_NOTE, removeStep, STEP_CHANNELS, STEP_STATUSES, updateStep, type StepPatch } from '@/modules/playbooks';
import { parseBody } from '../../../../_lib/body';
import { idAndAction, notFound } from '../../../../_lib/path';
import { v1Route } from '../../../../_lib/v1-route';

const text = (max: number) => z.string().max(max, `Keep this under ${max.toLocaleString('en-US')} characters.`);

const body = z.strictObject({
  status: z.enum(STEP_STATUSES).optional(),
  note: z.string().max(MAX_NOTE, `Keep this under ${MAX_NOTE.toLocaleString('en-US')} characters.`).nullable().optional(),
  owner_user_id: z.string().min(1).nullable().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31.').optional(),
  title: z.string().min(1, 'Give the step a title.').max(200, 'Keep this under 200 characters.').optional(),
  detail: text(MAX_NOTE).nullable().optional(),
  day: z.number().int('Use a whole number of days.').min(0, 'Use a day from 0 to 365.').max(365, 'Use a day from 0 to 365.').optional(),
  channel: z.enum(STEP_CHANNELS).optional(),
  subject: text(300).nullable().optional(),
  body: text(10_000).nullable().optional(),
  crm_task: z.boolean().optional(),
  target_buying_roles: z.array(z.string().min(1)).max(20).optional(),
});

const ids = (req: Request) => {
  const { id, action } = idAndAction(req, 'plans');
  const step = idAndAction(req, 'steps');
  if (action || step.action) throw notFound();
  return { planId: id, stepId: step.id };
};

/** Changes one step of a plan: status, note, owner, due date, or its content. Returns the whole plan. People only: step work is a person's. */
export const PATCH = v1Route({ permission: 'playbooks:write', peopleOnly: true }, async (req, _principal, ctx) => {
  const { planId, stepId } = ids(req);
  return updateStep(ctx, planId, stepId, await parseBody<StepPatch>(req, body));
});

/** Takes a step out of an open plan (409 for a done step or an ended plan). Returns the whole plan. */
export const DELETE = v1Route({ permission: 'playbooks:write', peopleOnly: true }, async (req, _principal, ctx) => {
  const { planId, stepId } = ids(req);
  return removeStep(ctx, planId, stepId);
});
