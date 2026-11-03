import { REQUEST_STATUSES, listRequests, type RequestStatus } from '@/modules/enrichment';
import { ScoutError } from '@/platform/errors';
import { pageLimit } from '../_lib/pagination';
import { v1Route } from '../_lib/v1-route';

/** Requests newest first, within the caller's data limit. `?status=`, `?account_id=`, `?cursor=`, `?limit=`. */
export const GET = v1Route({ permission: 'enrichment:request' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  if (status !== null && !REQUEST_STATUSES.includes(status as RequestStatus)) {
    const message = `Status must be one of: ${REQUEST_STATUSES.join(', ')}.`;
    throw new ScoutError({ slug: 'validation', status: 400, title: message, errors: [{ path: 'status', message }] });
  }
  const accountId = url.searchParams.get('account_id');
  const cursor = url.searchParams.get('cursor');
  return listRequests(ctx, {
    ...(status ? { status: status as RequestStatus } : {}),
    ...(accountId ? { accountId } : {}),
    ...(cursor ? { cursor } : {}),
    limit: pageLimit(url),
  });
});
