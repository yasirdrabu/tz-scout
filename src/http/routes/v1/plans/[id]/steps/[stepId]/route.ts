import { z } from 'zod';
import { MAX_NOTE, STEP_STATUSES, updateStep, type StepPatch } from '@/modules/playbooks';
import { parseBody } from '../../../../_lib/body';
import { idAndAction, notFound } from '../../../../_lib/path';
import { v1Route } from '../../../../_lib/v1-route';

const body = z.strictObject({
  status: z.enum(STEP_STATUSES).optional(),
  note: z.string().max(MAX_NOTE, `Keep this under ${MAX_NOTE.toLocaleString('en-US')} characters.`).nullable().optional(),
  owner_user_id: z.string().min(1).nullable().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31.').optional(),
});

/** Changes one step of a plan: status, note, owner or due date. Returns the whole plan. People only: step work is a person's. */
export const PATCH = v1Route({ permission: 'playbooks:write', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'plans');
  const step = idAndAction(req, 'steps');
  if (action || step.action) throw notFound();
  return updateStep(ctx, id, step.id, await parseBody<StepPatch>(req, body));
});
