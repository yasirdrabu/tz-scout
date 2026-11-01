import { z } from 'zod';
import { LIST_HAS_NO_KEYS, readSource } from '@/modules/intake';
import { KEY_ACCESS_CHOICES, assertSourceExists, createKeyWithAccess, listApiKeys, type KeyAccess } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { created, v1Route } from '../../../_lib/v1-route';

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

/** A key for this source, sending and checking status unless `access` says otherwise. The secret is in this response only. A list holds no keys (Ruling 1). */
// Not idempotent: a stored response would keep the secret, and a replay would hand it out again.
export const POST = v1Route({ permission: 'sources:manage', peopleOnly: true, idempotent: false }, async (req, principal, ctx) => {
  const id = sourceId(req);
  await assertSourceExists(ctx, id);
  if ((await readSource(ctx, id))?.kind === 'list') throw new ScoutError({ slug: 'validation', status: 400, title: LIST_HAS_NO_KEYS });
  const body = await parseBody<{ name: string; access?: KeyAccess; environment?: 'live' | 'test' }>(req, createBody);
  return created(await createKeyWithAccess(ctx, { ...body, access: body.access ?? 'send_and_status', sourceId: id }, principal));
});
