import { getAccount } from '@/modules/accounts';
import { submitArrival } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { readJson } from '../../../_lib/intake';
import { pageOfList } from '../../../_lib/pagination';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';
import { inlineReply, objectBody, personFor } from '../../respond';

export const GET = v1Route({ permission: 'accounts:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const account = await getAccount(ctx, id);
  if (!account) throw notFound();
  const canRead = can(principal, 'people:read');
  return pageOfList(req, account.people.map((p) => personFor(p, canRead)));
});

/** ACC-E1-S4: an inline targeted arrival with one person. */
export const POST = v1Route({ permission: 'people:write' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const person = objectBody(await readJson(req));
  if (principal.kind === 'user' && typeof person.notes === 'string' && person.notes.length > 1000) {
    const message = 'Keep the note under 1,000 characters.';
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Check the request.', errors: [{ path: 'notes', message }] });
  }
  const r = await submitArrival(
    ctx,
    { target_account_id: id, people: [person] },
    { channel: 'api', inline: true, canDeclareWarmIntro: can(principal, 'warm_intro:declare') },
  );
  return inlineReply(ctx, r, (x) => ({ arrivalId: x.arrivalId, personId: x.personIds[0], alreadyKnown: x.alreadyKnown }));
});
