import { z } from 'zod';
import { MAX_BULK, previewBulkAssign } from '@/modules/routing';
import { parseBody } from '../../_lib/body';
import { v1Route } from '../../_lib/v1-route';

const body = z.strictObject({ account_ids: z.array(z.string()).min(1).max(MAX_BULK), seller_user_id: z.string() });

/** The bulk Assign dialog's preview (Ruling 17): one row per account in the order asked, each `ok` with its preview or not with its status. */
export const POST = v1Route({ permission: 'assign:act', peopleOnly: true }, async (req, _principal, ctx) => {
  const { accountIds, sellerUserId } = await parseBody<{ accountIds: string[]; sellerUserId: string }>(req, body);
  return { data: await previewBulkAssign(ctx, accountIds, sellerUserId) };
});
