import { deleteMapping, listMappings } from '@/modules/intake';
import { idAndAction, notFound } from '../../../../_lib/path';
import { noContent, v1Route } from '../../../../_lib/v1-route';

export const dynamic = 'force-dynamic';

export const DELETE = v1Route({ permission: 'imports:run' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'sources');
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const mappingId = decodeURIComponent(parts[parts.indexOf('mappings') + 1] ?? '');
  if (action || !mappingId) throw notFound();
  // The mapping must belong to this source, and the source must be one the caller can see.
  if (!(await listMappings(ctx, id)).some((m) => m.id === mappingId)) throw notFound();
  await deleteMapping(ctx, mappingId);
  return noContent();
});
