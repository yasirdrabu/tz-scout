import { getBatch, readBatchRow, retryBatch, skipWaiting } from '@/modules/intake';
import { countQueue } from '@/modules/routing';
import { can, sessionUser } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { withoutContacts } from '../../_lib/intake';
import { idAndAction, notFound } from '../../_lib/path';
import { accepted, byAction, v1Route } from '../../_lib/v1-route';

/** The batch row (Ruling 8) with its counts by stage, rejections, files and, with `review:act`, how many are in the review queue. */
export const GET = v1Route({ permission: 'arrivals:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'batches');
  if (action) throw notFound();
  const found = await readBatchRow(ctx, id);
  if (!found) throw notFound();
  const detail = { ...found, inQueue: can(principal, 'review:act') ? await countQueue(ctx, { batchId: id }) : null };
  return can(principal, 'people:read') ? detail : withoutContacts(detail);
});

/**
 * `POST /batches/{id}:skip-waiting`: rejects the batch's waiting items as invalid, naming the person who skipped them.
 * `POST /batches/{id}:retry`: sends the rows the daily limit stopped again, and picks up an import its paused source stopped.
 */
export const POST = byAction('batches', {
  'skip-waiting': v1Route({ permission: 'imports:run', peopleOnly: true }, async (req, _principal, ctx) => {
    const { id } = idAndAction(req, 'batches');
    if (!(await getBatch(ctx, id))) throw notFound();
    const who = await sessionUser(req.headers);
    if (!who) throw new ScoutError({ slug: 'unauthenticated', status: 401, title: 'Sign in or send a valid API key.' });
    return { skipped: await skipWaiting(ctx, id, who.name) };
  }),
  retry: v1Route({ permission: 'imports:run', peopleOnly: true }, async (req, _principal, ctx) => {
    const { id } = idAndAction(req, 'batches');
    return accepted({ retried: await retryBatch(ctx, id) });
  }),
});
