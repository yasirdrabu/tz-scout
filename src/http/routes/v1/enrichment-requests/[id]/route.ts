import { z } from 'zod';
import { PEOPLE_ONLY, approveRequest, cancelRequest, declineRequest } from '@/modules/enrichment';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { accepted, byAction, v1Route } from '../../_lib/v1-route';

const declineBody = z.strictObject({ reason: z.string().optional() });

function idOf(req: Request): string {
  const { id } = idAndAction(req, 'enrichment-requests');
  if (!id) throw notFound();
  return id;
}

/** `POST /enrichment-requests/{id}:approve|decline|cancel`. Approving and declining spend are for people (Ruling 1). */
export const POST = byAction('enrichment-requests', {
  approve: v1Route({ permission: 'enrichment:approve', peopleOnly: PEOPLE_ONLY }, async (req, principal, ctx) =>
    accepted(await approveRequest(ctx, principal, idOf(req))),
  ),
  decline: v1Route({ permission: 'enrichment:approve', peopleOnly: PEOPLE_ONLY }, async (req, principal, ctx) => {
    const { reason } = await parseBody<{ reason?: string }>(req, declineBody);
    return declineRequest(ctx, principal, idOf(req), reason ?? '');
  }),
  cancel: v1Route({ permission: 'enrichment:request' }, async (req, principal, ctx) => cancelRequest(ctx, principal, idOf(req))),
});
