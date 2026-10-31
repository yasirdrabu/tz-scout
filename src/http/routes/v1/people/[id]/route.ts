import { editPerson, getPerson } from '@/modules/accounts';
import { submitArrival } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';
import { personFor, arrivalOutcome } from '../../accounts/respond';
import { patchFacts, patchPersonBody } from '../../accounts/schemas';

/** Same rule as PATCH /accounts/{id}: a person edit is pinned; a key edit goes through intake, aimed at this person. */
export const PATCH = v1Route({ permission: 'people:write' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'people');
  if (action) throw notFound();
  const patch = await parseBody<{ roleKeys?: string[] }>(req, patchPersonBody);
  const current = await getPerson(ctx, id);
  if (!current) throw notFound();
  if (principal.kind === 'user') {
    await editPerson(ctx, id, patch);
    return personFor((await getPerson(ctx, id))!, can(principal, 'people:read'));
  }
  if (patch.roleKeys) {
    throw new ScoutError({
      slug: 'validation',
      status: 400,
      title: 'Check the request.',
      errors: [{ path: 'role_keys', message: 'Only a person can change roles.' }],
    });
  }
  const r = await submitArrival(
    ctx,
    { target_account_id: current.accountId, facts: patchFacts(patch, 'person') },
    { channel: 'api', inline: true, targetPersonId: id, canDeclareWarmIntro: can(principal, 'warm_intro:declare') },
  );
  return arrivalOutcome(ctx, r);
});
