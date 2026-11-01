import { exportAccounts } from '@/modules/routing';
import { v1Route } from '../../_lib/v1-route';
import { accountFilters } from '../filters';

/** `Export CSV`: the list's rows for the same filters, as scout-accounts.csv; `x-scout-row-count` says how many. */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const { csv, count } = await exportAccounts(ctx, accountFilters(new URL(req.url)));
  return new Response(csv, {
    status: 200,
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="scout-accounts.csv"', 'x-scout-row-count': String(count) },
  });
});
