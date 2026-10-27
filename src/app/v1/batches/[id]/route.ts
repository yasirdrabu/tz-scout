import { getBatch } from '@/modules/intake';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

export const GET = v1Route({ permission: 'arrivals:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'batches');
  if (action) throw notFound();
  const found = await getBatch(ctx, id);
  if (!found) throw notFound();
  return found;
});
