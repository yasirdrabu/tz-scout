import { z } from 'zod';
import { addNote, listNotes } from '@/modules/accounts';
import { can } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { created, v1Route } from '../../../_lib/v1-route';

const body = z.strictObject({ body: z.string() });

/** Decision 3: the account's notes, newest first, for everyone who can see the account. */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  return listNotes(ctx, id);
});

/** Adds a note (up to 4,000 characters). Reviewers (`review:act`) and people who edit accounts (`accounts:write`). */
export const POST = v1Route({ peopleOnly: true }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  if (!can(principal, 'review:act') && !can(principal, 'accounts:write')) {
    throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Forbidden', detail: 'You need review:act or accounts:write.' });
  }
  return created(await addNote(ctx, id, (await parseBody<{ body: string }>(req, body)).body));
});
