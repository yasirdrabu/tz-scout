import { z } from 'zod';
import { bulk, type BulkAction } from '@/modules/routing';
import { can } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { parseBody } from '../../_lib/body';
import { v1Route } from '../../_lib/v1-route';

const optional = z.string().nullish();
const bulkBody = z.discriminatedUnion('action', [
  z.strictObject({ account_ids: z.array(z.string()), action: z.literal('status'), to: z.string(), note: optional, reason_key: optional }),
  z.strictObject({
    account_ids: z.array(z.string()),
    action: z.literal('assign'),
    seller_user_id: z.string(),
    notes: optional,
    lead_offer_id: optional,
    ownership_decision: z.enum(['assign', 'keep']).optional(),
  }),
]);

/** One action on up to 50 accounts. `review:act` covers a status change; assigning also needs `assign:act`. Each account has its own result. */
export const POST = v1Route({ permission: 'review:act', peopleOnly: true }, async (req, principal, ctx) => {
  const { accountIds, action, ...rest } = await parseBody<{ accountIds: string[]; action: 'status' | 'assign' } & Record<string, unknown>>(req, bulkBody);
  if (action === 'assign' && !can(principal, 'assign:act')) throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Forbidden', detail: 'You can set statuses but not assign accounts.' });
  return { results: await bulk(ctx, accountIds, { kind: action, ...rest } as BulkAction) };
});
