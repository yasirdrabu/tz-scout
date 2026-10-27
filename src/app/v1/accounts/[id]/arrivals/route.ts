import { getAccount } from '@/modules/accounts';
import { listArrivals } from '@/modules/intake';
import { pageLimit } from '../../../_lib/pagination';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

export const dynamic = 'force-dynamic';

export const GET = v1Route({ permission: 'arrivals:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const account = await getAccount(ctx, id);
  if (!account) throw notFound();
  const url = new URL(req.url);
  return listArrivals(ctx, { accountId: account.id, cursor: url.searchParams.get('cursor') || undefined, limit: pageLimit(url) });
});
