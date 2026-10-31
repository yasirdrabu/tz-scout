import { removePlatformAdmin } from '@/modules/tenancy';
import { idAndAction, notFound } from '../../../_lib/path';
import { adminRoute, noContent } from '../../../_lib/v1-route';

export const dynamic = 'force-dynamic';

/** Takes the platform admin flag away (`{id}` is the user id). Not yourself, and never the last one. */
export const DELETE = adminRoute({}, async (req, _person, ctx) => {
  const { id, action } = idAndAction(req, 'platform-admins');
  if (action) throw notFound();
  await removePlatformAdmin(ctx, id);
  return noContent();
});
