import { z } from 'zod';
import { accept, decline, getAssignment, withdraw, type DeclineInput } from '@/modules/routing';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { byAction, v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

const declineBody = z.strictObject({ reason_key: z.string().optional(), note: z.string().nullish() });
const withdrawBody = z.strictObject({ reassign_to: z.string().min(1).optional() });

const assignmentOf = async (req: Request, ctx: Parameters<typeof getAssignment>[0]) => {
  const row = await getAssignment(ctx, idAndAction(req, 'assignments').id);
  if (!row) throw notFound();
  return row;
};

/** `POST /assignments/{id}:action`. A seller acts on their own assignment (another seller's is a 404); each returns the assignment. */
export const POST = byAction('assignments', {
  accept: v1Route({ permission: 'assignments:respond', peopleOnly: true }, async (req, _principal, ctx) => {
    await accept(ctx, idAndAction(req, 'assignments').id);
    return assignmentOf(req, ctx);
  }),
  decline: v1Route({ permission: 'assignments:respond', peopleOnly: true }, async (req, _principal, ctx) => {
    await decline(ctx, idAndAction(req, 'assignments').id, await parseBody<DeclineInput>(req, declineBody));
    return assignmentOf(req, ctx);
  }),
  withdraw: v1Route({ permission: 'assign:act', peopleOnly: true }, async (req, _principal, ctx) => {
    // The body is optional: a bare POST withdraws without giving the account to anyone.
    const { reassignTo } = (await req.clone().text()).trim() ? await parseBody<{ reassignTo?: string }>(req, withdrawBody) : { reassignTo: undefined };
    const out = await withdraw(ctx, idAndAction(req, 'assignments').id, reassignTo ? { reassignTo } : {});
    return { ...(await assignmentOf(req, ctx)), reassigned: out.reassigned };
  }),
});
