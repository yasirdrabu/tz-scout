import { getBatch } from '@/modules/crm';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

export const GET = v1Route({ permission: 'crm:push', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'handoff-batches');
  const batch = action ? null : await getBatch(ctx, id);
  if (!batch) throw notFound();
  return batch;
});
