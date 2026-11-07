import { parseTab, scorecard } from '@/modules/analytics';
import { v1Route } from '../../_lib/v1-route';

/** The Overview scorecard by seller, offer or practice (R3c-1): `?tab=` is required, and the numbers follow the caller's data limit. */
export const GET = v1Route({ permission: 'analytics:read' }, async (req, _principal, ctx) =>
  scorecard(ctx, parseTab(new URL(req.url).searchParams.get('tab'))),
);
