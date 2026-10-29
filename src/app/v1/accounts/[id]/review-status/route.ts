import { z } from 'zod';
import { changeStatus, type StatusChangeInput } from '@/modules/routing';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

export const dynamic = 'force-dynamic';

const body = z.strictObject({ to: z.string(), note: z.string().nullish(), reason_key: z.string().nullish() });

/** REV-E1-S2: change the review status (send back, decline, reopen). Returns the account's review state. */
export const PATCH = v1Route({ permission: 'review:act', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  return changeStatus(ctx, id, await parseBody<StatusChangeInput>(req, body));
});
