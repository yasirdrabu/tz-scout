import { listMappings } from '@/modules/intake';
import { withoutReasons } from '../../../_lib/intake';
import { pageOfList } from '../../../_lib/pagination';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';
import { can } from '@/modules/tenancy';

export const GET = v1Route({ permission: 'imports:run' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'sources');
  if (action) throw notFound();
  const rows = await listMappings(ctx, id);
  return pageOfList(req, can(principal, 'people:read') ? rows : rows.map((m) => ({ ...m, mapping: withoutReasons(m.mapping) })));
});
