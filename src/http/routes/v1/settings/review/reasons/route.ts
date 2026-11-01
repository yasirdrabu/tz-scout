import { z } from 'zod';
import { listReasons, saveReasons } from '@/modules/routing';
import { parseBody } from '../../../_lib/body';
import { v1Route } from '../../../_lib/v1-route';
import { canReadReviewLists } from '../access';

const body = z.strictObject({
  reasons: z.array(
    z.strictObject({
      key: z.string().nullish(),
      label: z.string(),
      applies_to: z.string(),
      note_required: z.boolean(),
      archived: z.boolean().optional(),
    }),
  ),
});
type Item = z.infer<typeof body>['reasons'][number];

/** Send-back, review decline and seller decline reasons, in order. `used_this_quarter` only for `settings:manage`. */
export const GET = v1Route({}, async (_req, principal, ctx) => ({ data: await listReasons(ctx, canReadReviewLists(principal)) }));

/** Decision 1 and 2: every reason in order, each with its list and "Note required"; one without a key is added. */
export const PUT = v1Route({ permission: 'settings:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const { reasons } = await parseBody<{ reasons: Item[] }>(req, body);
  const data = await saveReasons(
    ctx,
    reasons.map((r) => ({ key: r.key, label: r.label, appliesTo: r.applies_to, noteRequired: r.note_required, archived: r.archived })),
  );
  return { data };
});
