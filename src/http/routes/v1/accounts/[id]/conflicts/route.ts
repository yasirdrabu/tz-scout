import { getAccount, listConflicts } from '@/modules/accounts';
import { pageOfList } from '../../../_lib/pagination';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';
import { conflictReplies, hidesConflict } from '../../respond';

/** `GET /accounts/{id}/conflicts`: open conflicts, then those resolved in the last 30 days (ACC-E3-S3). */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const account = await getAccount(ctx, id);
  if (!account) throw notFound();
  const conflicts = (await listConflicts(ctx, account.id)).filter((c) => !hidesConflict(principal, c));
  return pageOfList(req, await conflictReplies(ctx, conflicts));
});
