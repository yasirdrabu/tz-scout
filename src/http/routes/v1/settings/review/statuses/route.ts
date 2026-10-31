import { z } from 'zod';
import { listStatuses, saveStatuses } from '@/modules/routing';
import { parseBody } from '../../../_lib/body';
import { v1Route } from '../../../_lib/v1-route';
import { canReadReviewLists } from '../access';

// The service checks colors, names and hours, so a person gets the plain-words messages.
const body = z.strictObject({
  statuses: z.array(
    z.strictObject({
      key: z.string().nullish(),
      label: z.string(),
      color: z.string(),
      description: z.string().nullish(),
      set_by: z.string(),
      flag_after_hours: z.number().nullable(),
      archived: z.boolean().optional(),
    }),
  ),
});
type Item = z.infer<typeof body>['statuses'][number];

/** The review statuses in order, archived ones included. Counts ("In it now", "{n} late") only for `settings:manage`. */
export const GET = v1Route({}, async (_req, principal, ctx) => ({ data: await listStatuses(ctx, canReadReviewLists(principal)) }));

/** Decision 2: the whole list in order; a status without a key is added, archiving moves its accounts to the first status. */
export const PUT = v1Route({ permission: 'settings:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const { statuses } = await parseBody<{ statuses: Item[] }>(req, body);
  const data = await saveStatuses(
    ctx,
    statuses.map((s) => ({ key: s.key, label: s.label, color: s.color, description: s.description, setBy: s.set_by, flagAfterHours: s.flag_after_hours, archived: s.archived })),
  );
  return { data };
});
