import { recentCalls } from '@/modules/integrations';
import { ScoutError } from '@/platform/errors';
import { scrubError } from '@/platform/scrub-error';
import { v1Route } from '../../../_lib/v1-route';
import { integrationKey } from '../../key';

export const dynamic = 'force-dynamic';

/** The last 50 calls to the service, newest first; `?errors_only=true` keeps the ones that did not work. */
export const GET = v1Route({ permission: 'integrations:manage' }, async (req, _principal, ctx) => {
  const key = integrationKey(req);
  const raw = new URL(req.url).searchParams.get('errors_only');
  if (raw !== null && raw !== 'true' && raw !== 'false') {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'errors_only must be true or false.' });
  }
  const rows = await recentCalls(ctx, key, 50, { errorsOnly: raw === 'true' });
  return { data: rows.map((r) => ({ ...r, errorMessage: r.errorMessage === null ? null : scrubError(r.errorMessage) })) };
});
