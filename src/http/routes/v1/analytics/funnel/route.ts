import { funnel } from '@/modules/analytics';
import { can } from '@/modules/tenancy';
import { funnelFilters } from '../../_lib/funnel-filters';
import { v1Route } from '../../_lib/v1-route';

/** Funnel by source (R3b-1 Ruling 10): spend fields are null without `costs:read`; the cohort follows the data limit. */
export const GET = v1Route({ permission: 'analytics:read' }, async (req, principal, ctx) =>
  funnel(ctx, funnelFilters(req), { spend: can(principal, 'costs:read') }),
);
