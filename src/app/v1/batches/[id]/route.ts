import { getBatch, listBatchFiles } from '@/modules/intake';
import { withoutContacts } from '../../_lib/intake';
import { can } from '@/modules/tenancy';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

export const GET = v1Route({ permission: 'arrivals:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'batches');
  if (action) throw notFound();
  const found = await getBatch(ctx, id);
  if (!found) throw notFound();
  const detail = { ...found, files: (await listBatchFiles(ctx, id)) ?? [] };
  return can(principal, 'people:read') ? detail : withoutContacts(detail);
});
