import { z } from 'zod';
import { LIST_HAS_NO_KEYS, listSources, readSource } from '@/modules/intake';
import { ScoutError } from '@/platform/errors';
import { KEY_ACCESS_CHOICES, createKeyWithAccess, listApiKeys, type KeyAccess } from '@/modules/tenancy';
import { parseBody } from '../_lib/body';
import { created, v1Route } from '../_lib/v1-route';

// Every key in the workspace (or one source's with `?source_id=`), masked, with source and creator names.
export const GET = v1Route({ permission: 'keys:manage' }, async (req, _principal, ctx) => {
  const sourceId = new URL(req.url).searchParams.get('source_id') || undefined;
  const names = new Map((await listSources(ctx, { statuses: ['active', 'paused', 'archived'] })).map((s) => [s.id, s.name]));
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
  // A list gets its accounts from files, so it holds no keys (Ruling 1).
  if ((await readSource(ctx, body.sourceId))?.kind === 'list') throw new ScoutError({ slug: 'validation', status: 400, title: LIST_HAS_NO_KEYS });
  return created(await createKeyWithAccess(ctx, body, principal));
});
