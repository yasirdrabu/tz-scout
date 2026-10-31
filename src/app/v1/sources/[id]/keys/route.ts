import { z } from 'zod';
import { KEY_ACCESS_CHOICES, assertSourceExists, createKeyWithAccess, listApiKeys, type KeyAccess } from '@/modules/tenancy';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { created, v1Route } from '../../../_lib/v1-route';

export const dynamic = 'force-dynamic';

const sourceId = (req: Request) => {
  const { id, action } = idAndAction(req, 'sources');
  if (action) throw notFound();
  return id;
};

// This source's keys only, masked (Decision 14).
export const GET = v1Route({ permission: 'sources:manage' }, async (req, _principal, ctx) => {
  const id = sourceId(req);
  await assertSourceExists(ctx, id);
  return { data: await listApiKeys(ctx, { sourceId: id }) };
});

const createBody = z.strictObject({
  name: z.string(),
  access: z.enum(KEY_ACCESS_CHOICES).optional(),
  environment: z.enum(['live', 'test']).optional(),
});

/** A key for this source, sending and checking status unless `access` says otherwise. The secret is in this response only. */
export const POST = v1Route({ permission: 'sources:manage', peopleOnly: true }, async (req, principal, ctx) => {
  const id = sourceId(req);
  await assertSourceExists(ctx, id);
  const body = await parseBody<{ name: string; access?: KeyAccess; environment?: 'live' | 'test' }>(req, createBody);
  return created(await createKeyWithAccess(ctx, { ...body, access: body.access ?? 'send_and_status', sourceId: id }, principal));
});
