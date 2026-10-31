import { z } from 'zod';
import { listSources } from '@/modules/intake';
import { KEY_ACCESS_CHOICES, createKeyWithAccess, listApiKeys, type KeyAccess } from '@/modules/tenancy';
import { parseBody } from '../_lib/body';
import { created, v1Route } from '../_lib/v1-route';

export const dynamic = 'force-dynamic';

// Every key in the workspace (or one source's with `?source_id=`), masked, with source and creator names.
export const GET = v1Route({ permission: 'keys:manage' }, async (req, _principal, ctx) => {
  const sourceId = new URL(req.url).searchParams.get('source_id') || undefined;
  const names = new Map((await listSources(ctx)).map((s) => [s.id, s.name]));
  const keys = await listApiKeys(ctx, { sourceId });
  return { data: keys.map((k) => ({ ...k, sourceName: k.sourceId ? (names.get(k.sourceId) ?? null) : null })) };
});

const createBody = z.strictObject({
  name: z.string(),
  source_id: z.string().min(1),
  access: z.enum(KEY_ACCESS_CHOICES),
  environment: z.enum(['live', 'test']).optional(),
});

/** Creates a key for one source from an access choice (Decision 14). The secret is in this response only. */
// Not idempotent: a stored response would keep the secret, and a replay would hand it out again.
export const POST = v1Route({ permission: 'keys:manage', peopleOnly: true, idempotent: false }, async (req, principal, ctx) => {
  const body = await parseBody<{ name: string; sourceId: string; access: KeyAccess; environment?: 'live' | 'test' }>(req, createBody);
  return created(await createKeyWithAccess(ctx, body, principal));
});
