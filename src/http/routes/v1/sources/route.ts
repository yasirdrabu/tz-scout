import { z } from 'zod';
import { listSources, registerSource, SOURCE_KINDS, type RegisterSourceInput } from '@/modules/intake';
import { memberRole } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { parseBody } from '../_lib/body';
import { pageOfList } from '../_lib/pagination';
import { created, v1Route } from '../_lib/v1-route';

const createSourceBody = z
  .strictObject({
    kind: z.enum(SOURCE_KINDS),
    name: z.string(),
    parent_id: z.string(),
    user_id: z.string(),
    daily_arrival_cap: z.number(),
    initial_review_status_key: z.string(),
    settings: z.record(z.string(), z.unknown()),
  })
  .partial()
  .required({ kind: true, name: true });

export const GET = v1Route({ permission: 'arrivals:read' }, async (req, _principal, ctx) =>
  pageOfList(req, await listSources(ctx)),
);

export const POST = v1Route({ permission: 'sources:manage' }, async (req, _principal, ctx) => {
  const input = await parseBody<RegisterSourceInput>(req, createSourceBody);
  if (input.userId && !(await memberRole(ctx, input.userId))) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'That person is not a member of this workspace.' });
  }
  return created(await registerSource(ctx, input));
});
