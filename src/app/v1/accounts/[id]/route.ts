import { z } from 'zod';
import { convertShell, editAccount, mergeAccounts, overrideExclusion, pinPrimary } from '@/modules/accounts';
import { submitArrival } from '@/modules/intake';
import { assign, markSeen, previewAssign, type AssignInput } from '@/modules/routing';
import { can } from '@/modules/tenancy';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { accepted, byAction, v1Route } from '../../_lib/v1-route';
import { accountOf, arrivalOutcome } from '../respond';
import { patchAccountBody, patchFacts } from '../schemas';

export const dynamic = 'force-dynamic';

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

const mergeBody = z.strictObject({ merged_id: z.string() });
const pinBody = z.strictObject({ person_id: z.string().nullable() });
const overrideBody = z.strictObject({ note: z.string() });
const assignBody = z.strictObject({
  seller_user_id: z.string(),
  notes: z.string().nullish(),
  lead_offer_id: z.string().nullish(),
  ownership_decision: z.enum(['assign', 'keep']).optional(),
});
const previewBody = z.strictObject({ seller_user_id: z.string() });
const shellBody = z.strictObject({ name: z.string(), domain: z.string() });

/** `POST /accounts/{id}:action`. All are people only; the service of each checks the data limit. Assigning is 202. */
export const POST = byAction('accounts', {
  merge: v1Route({ permission: 'accounts:write', peopleOnly: 'Only a person can merge accounts.' }, async (req, principal, ctx) => {
    const { id } = idAndAction(req, 'accounts');
    const { mergedId } = await parseBody<{ mergedId: string }>(req, mergeBody);
    await mergeAccounts(ctx, id, mergedId);
    return accountOf(ctx, id, can(principal, 'people:read'));
  }),
  'pin-primary': v1Route({ permission: 'accounts:write', peopleOnly: true }, async (req, principal, ctx) => {
    const { id } = idAndAction(req, 'accounts');
    await pinPrimary(ctx, id, (await parseBody<{ personId: string | null }>(req, pinBody)).personId);
    return accountOf(ctx, id, can(principal, 'people:read'));
  }),
  'override-exclusion': v1Route({ permission: 'accounts:write', peopleOnly: true }, async (req, principal, ctx) => {
    const { id } = idAndAction(req, 'accounts');
    await overrideExclusion(ctx, id, (await parseBody<{ note: string }>(req, overrideBody)).note);
    return accountOf(ctx, id, can(principal, 'people:read'));
  }),
  'convert-shell': v1Route({ permission: 'accounts:write', peopleOnly: true }, async (req, principal, ctx) => {
    const { id } = idAndAction(req, 'accounts');
    await convertShell(ctx, id, await parseBody<{ name: string; domain: string }>(req, shellBody));
    return accountOf(ctx, id, can(principal, 'people:read'));
  }),
  assign: v1Route({ permission: 'assign:act', peopleOnly: true }, async (req, _principal, ctx) => {
    const { id } = idAndAction(req, 'accounts');
    return accepted(await assign(ctx, id, await parseBody<AssignInput>(req, assignBody)));
  }),
  'assign-preview': v1Route({ permission: 'assign:act', peopleOnly: true }, async (req, _principal, ctx) => {
    const { id } = idAndAction(req, 'accounts');
    return previewAssign(ctx, id, (await parseBody<{ sellerUserId: string }>(req, previewBody)).sellerUserId);
  }),
  /** The assigned seller has seen the new arrival ("New from <source>"). No body. */
  seen: v1Route({ permission: 'assignments:respond', peopleOnly: true }, async (req, _principal, ctx) => markSeen(ctx, idAndAction(req, 'accounts').id)),
});
