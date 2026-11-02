import { z } from 'zod';
import { getConflict, resolveConflict } from '@/modules/accounts';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { byAction, v1Route } from '../../_lib/v1-route';
import { conflictReplies, hidesConflict } from '../../accounts/respond';

const resolveBody = z.strictObject({ kept_fact_id: z.string().min(1), note: z.string().max(1000).optional() });

/** `POST /conflicts/{id}:resolve` keeps one value; on a resolved conflict it changes the kept value (ACC-E3-S4). */
export const POST = byAction('conflicts', {
  resolve: v1Route({ permission: 'review:act', peopleOnly: 'Only a person can settle a disagreement between sources.' }, async (req, principal, ctx) => {
    const { id } = idAndAction(req, 'conflicts');
    const { keptFactId, note } = await parseBody<{ keptFactId: string; note?: string }>(req, resolveBody);
    const seen = await getConflict(ctx, id);
    if (!seen || hidesConflict(principal, seen)) throw notFound();
    const [reply] = await conflictReplies(ctx, [await resolveConflict(ctx, id, keptFactId, note)]);
    return reply!;
  }),
});
