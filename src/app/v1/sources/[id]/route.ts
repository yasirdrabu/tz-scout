import { z } from 'zod';
import { updateSource, type SourcePatch } from '@/modules/intake';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

const patchSourceBody = z
  .strictObject({
    name: z.string(),
    status: z.enum(['active', 'paused', 'archived']),
    daily_arrival_cap: z.number(),
    initial_review_status_key: z.string(),
  })
  .partial();

/** People only: a key must not lift its own pause or cap. Pause, resume, archive, rename, change the daily limit or the starting review status. */
export const PATCH = v1Route({ permission: 'sources:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'sources');
  if (action) throw notFound();
  return updateSource(ctx, id, await parseBody<SourcePatch>(req, patchSourceBody));
});
