import { editAccount, getAccount, getSignals } from '@/modules/accounts';
import { submitArrival } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';
import { personFor, arrivalOutcome } from '../respond';
import { patchAccountBody, patchFacts } from '../schemas';

export const dynamic = 'force-dynamic';

async function accountOf(ctx: ModuleContext, id: string, canReadPeople: boolean) {
  const account = await getAccount(ctx, id);
  if (!account) throw notFound();
  return { ...account, mergedInto: account.mergedInto ?? null, people: account.people.map((p) => personFor(p, canReadPeople)), signals: await getSignals(ctx, account.id) };
}

export const GET = v1Route({ permission: 'accounts:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  return accountOf(ctx, id, can(principal, 'people:read'));
});

/** A person edit is pinned. A key edit goes through intake as an inline targeted arrival, so it keeps provenance and trust (Ruling 9). */
export const PATCH = v1Route({ permission: 'accounts:write' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const patch = await parseBody(req, patchAccountBody);
  if (principal.kind === 'user') {
    await editAccount(ctx, id, patch);
    return accountOf(ctx, id, can(principal, 'people:read'));
  }
  const r = await submitArrival(
    ctx,
    { target_account_id: id, facts: patchFacts(patch, 'account') },
    { channel: 'api', inline: true, canDeclareWarmIntro: can(principal, 'warm_intro:declare') },
  );
  return arrivalOutcome(ctx, r);
});
