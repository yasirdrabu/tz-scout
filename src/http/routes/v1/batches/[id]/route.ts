import { getBatch, listBatchFiles, skipWaiting } from '@/modules/intake';
import { withoutContacts } from '../../_lib/intake';
import { can, sessionUser } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { idAndAction, notFound } from '../../_lib/path';
import { byAction, v1Route } from '../../_lib/v1-route';

export const GET = v1Route({ permission: 'arrivals:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'batches');
  if (action) throw notFound();
  const found = await getBatch(ctx, id);
  if (!found) throw notFound();
  const detail = { ...found, files: (await listBatchFiles(ctx, id)) ?? [] };
  return can(principal, 'people:read') ? detail : withoutContacts(detail);
});

/** `POST /batches/{id}:skip-waiting`: rejects the batch's waiting items as invalid, naming the person who skipped them. */
export const POST = byAction('batches', {
  'skip-waiting': v1Route({ permission: 'imports:run', peopleOnly: true }, async (req, _principal, ctx) => {
    const { id } = idAndAction(req, 'batches');
    if (!(await getBatch(ctx, id))) throw notFound();
    const who = await sessionUser(req.headers);
    if (!who) throw new ScoutError({ slug: 'unauthenticated', status: 401, title: 'Sign in or send a valid API key.' });
    return { skipped: await skipWaiting(ctx, id, who.name) };
  }),
});
