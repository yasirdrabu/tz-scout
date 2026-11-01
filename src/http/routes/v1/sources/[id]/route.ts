import { z } from 'zod';
import { readSource, removeSource, requestSync, sourceDetail, updateSource, type SourcePatch } from '@/modules/intake';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { accepted, noContent, v1Route } from '../../_lib/v1-route';

const patchSourceBody = z
  .strictObject({
    name: z.string(),
    status: z.enum(['active', 'paused', 'archived']),
    owner_user_id: z.string().nullable(),
    daily_arrival_cap: z.number(),
    initial_review_status_key: z.string(),
  })
  .partial();

const plainId = (req: Request) => {
  const { id, action } = idAndAction(req, 'sources');
  if (action) throw notFound();
  return id;
};

/** One source for the Source page (§11): breadcrumb, owner, how it sends, its limits and, for HubSpot, its sync. */
export const GET = v1Route({ permission: 'sources:manage' }, async (req, _principal, ctx) => {
  const detail = await sourceDetail(ctx, plainId(req));
  if (!detail) throw notFound();
  return detail;
});

/** People only: a key must not lift its own pause or cap. Pause, resume, archive, rename, change the owner, the daily limit or the starting review status. */
export const PATCH = v1Route({ permission: 'sources:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const id = plainId(req);
  await updateSource(ctx, id, await parseBody<SourcePatch>(req, patchSourceBody));
  const detail = await sourceDetail(ctx, id);
  if (!detail) throw notFound();
  return detail;
});

/** Removes a source that has sent nothing (Decision 13); one that has sent is a 409 and can only be archived. */
export const DELETE = v1Route({ permission: 'sources:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  await removeSource(ctx, plainId(req));
  return noContent();
});

/** `:sync` on the HubSpot source queues the qualified-leads poll. */
export const POST = v1Route({ permission: 'sources:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'sources');
  if (action !== 'sync') throw notFound();
  const row = await readSource(ctx, id);
  if (!row) throw notFound();
  await requestSync(ctx, row.kind);
  return accepted({ queued: true });
});
