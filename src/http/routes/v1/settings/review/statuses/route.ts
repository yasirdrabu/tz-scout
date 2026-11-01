import { z } from 'zod';
import { listStatuses, saveStatuses } from '@/modules/routing';
import { parseBody } from '../../../_lib/body';
import { v1Route } from '../../../_lib/v1-route';
import { canReadReviewLists } from '../access';
import { statusItem, toStatusEdits } from '../edits';

const body = z.strictObject({ statuses: z.array(statusItem) });

/** The review statuses in order, archived ones included. Counts ("In it now", "{n} late") only for `settings:manage`. */
export const GET = v1Route({}, async (_req, principal, ctx) => ({ data: await listStatuses(ctx, canReadReviewLists(principal)) }));

/** Decision 2: the whole list in order; a status without a key is added, archiving moves its accounts to the first status. */
export const PUT = v1Route({ permission: 'settings:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const { statuses } = await parseBody<z.infer<typeof body>>(req, body);
  return { data: await saveStatuses(ctx, toStatusEdits(statuses)) };
});
