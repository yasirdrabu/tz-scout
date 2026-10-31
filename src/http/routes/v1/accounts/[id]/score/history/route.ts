import { getAccount } from '@/modules/accounts';
import { causeInWords, getScoreHistory } from '@/modules/scoring';
import { idAndAction, notFound } from '../../../../_lib/path';
import { v1Route } from '../../../../_lib/v1-route';

/** SCO-E4-S3: the last score changes, newest first, `?limit=` 1 to 50 (default 10). */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action || !(await getAccount(ctx, id))) throw notFound();
  const raw = new URL(req.url).searchParams.get('limit');
  const changes = await getScoreHistory(ctx, id, raw === null ? {} : { limit: Number(raw) });
  return { data: changes.map(({ tenantId: _t, causeEventId: _e, ...c }) => ({ ...c, causeText: causeInWords(c.cause) })) };
});
