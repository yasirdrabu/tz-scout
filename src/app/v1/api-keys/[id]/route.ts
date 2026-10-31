import { revokeApiKey } from '@/modules/tenancy';
import { idAndAction, notFound } from '../../_lib/path';
import { noContent, v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

/** Revokes the key. Calls with it fail within 60 seconds on every instance (at once on this one). */
export const DELETE = v1Route({ permission: 'keys:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'api-keys');
  if (action) throw notFound();
  await revokeApiKey(ctx, id, 'Revoked');
  return noContent();
});
