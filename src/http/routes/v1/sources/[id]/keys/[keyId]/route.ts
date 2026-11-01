import { readSource } from '@/modules/intake';
import { revokeSourceKey, rotateSourceKey } from '@/modules/tenancy';
import { idAndAction, notFound } from '../../../../_lib/path';
import { created, noContent, v1Route } from '../../../../_lib/v1-route';

/** The source (which must be one the caller can see) and the key under it, with the action after the key id. */
async function sourceAndKey(req: Request, ctx: Parameters<Parameters<typeof v1Route>[1]>[2]) {
  const source = idAndAction(req, 'sources');
  if (source.action) throw notFound();
  if (!(await readSource(ctx, source.id))) throw notFound();
  return { sourceId: source.id, key: idAndAction(req, 'keys') };
}

/**
 * `:rotate` (Decision 14, Ruling 7): a new key like the old one, then the old one revoked, in one transaction. The
 * secret is in this response only. The old key stops working within a minute (at once on this instance).
 */
// Not idempotent: a stored response would keep the secret, and a replay would hand it out again.
export const POST = v1Route({ permission: 'sources:manage', peopleOnly: true, idempotent: false }, async (req, principal, ctx) => {
  const { sourceId, key } = await sourceAndKey(req, ctx);
  if (key.action !== 'rotate') throw notFound();
  return created(await rotateSourceKey(ctx, sourceId, key.id, principal));
});

/** Revokes one key of this source; a key of another source is a 404. */
export const DELETE = v1Route({ permission: 'sources:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const { sourceId, key } = await sourceAndKey(req, ctx);
  if (key.action) throw notFound();
  await revokeSourceKey(ctx, sourceId, key.id);
  return noContent();
});
