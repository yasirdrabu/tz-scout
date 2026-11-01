import { deleteMapping, listMappings } from '@/modules/intake';
import { idAndAction, notFound } from '../../../../_lib/path';
import { noContent, v1Route } from '../../../../_lib/v1-route';

export const DELETE = v1Route({ permission: 'imports:run' }, async (req, _principal, ctx) => {
  const { id: sourceId, action } = idAndAction(req, 'sources');
  const { id: mappingId, action: mappingAction } = idAndAction(req, 'mappings');
  if (action || mappingAction) throw notFound();
  // The mapping must belong to the source in the path; the service hides sources outside the data limit.
  if (!(await listMappings(ctx, sourceId)).some((m) => m.id === mappingId)) throw notFound();
  await deleteMapping(ctx, mappingId);
  return noContent();
});
