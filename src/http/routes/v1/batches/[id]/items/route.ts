import { listBatchItems } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { withoutContacts } from '../../../_lib/intake';
import { pageLimit } from '../../../_lib/pagination';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

export const GET = v1Route({ permission: 'arrivals:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'batches');
  if (action) throw notFound();
  const url = new URL(req.url);
  const page = await listBatchItems(ctx, id, { cursor: url.searchParams.get('cursor') || undefined, limit: pageLimit(url) });
  if (!page) throw notFound();
  return can(principal, 'people:read') ? page : withoutContacts(page);
});
