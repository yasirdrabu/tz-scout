import { editManualLine, voidLine, type ManualLineInput } from '@/modules/analytics';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { byAction, v1Route } from '../../../_lib/v1-route';
import { editLineBody, voidLineBody } from '../schemas';

function idOf(req: Request, action: boolean): string {
  const { id, action: a } = idAndAction(req, 'lines');
  if (!id || (a !== null) !== action) throw notFound();
  return id;
}

/** `PATCH /costs/lines/{id}`: manual lines only, people only. The old line is voided "Edited" and the new one returned. */
export const PATCH = v1Route({ permission: 'costs:write', peopleOnly: true }, async (req, _principal, ctx) => {
  const id = idOf(req, false);
  return editManualLine(ctx, id, await parseBody<Partial<ManualLineInput>>(req, editLineBody));
});

/** `POST /costs/lines/{id}:void` with `{ reason }`. People only, like add and edit. */
export const POST = byAction('lines', {
  void: v1Route({ permission: 'costs:write', peopleOnly: true }, async (req, _principal, ctx) => {
    const id = idOf(req, true);
    const { reason } = await parseBody<{ reason?: string }>(req, voidLineBody);
    return voidLine(ctx, id, reason ?? '');
  }),
});
