import { sourcePerformance } from '@/modules/analytics';
import { can } from '@/modules/tenancy';
import { funnelFilters } from '../../../../_lib/funnel-filters';
import { idAndAction } from '../../../../_lib/path';
import { v1Route } from '../../../../_lib/v1-route';

/** One source's funnel against all sources (R3b-1 Ruling 11); 404 for an unknown or removed source. */
export const GET = v1Route({ permission: 'analytics:read' }, async (req, principal, ctx) =>
  sourcePerformance(ctx, idAndAction(req, 'sources').id, funnelFilters(req), { spend: can(principal, 'costs:read') }),
);
