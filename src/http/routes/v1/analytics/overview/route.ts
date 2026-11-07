import { overview } from '@/modules/analytics';
import { v1Route } from '../../_lib/v1-route';

/** Overview tiles, funnel bands and exits (R3c-1): the numbers follow the caller's data limit. */
export const GET = v1Route({ permission: 'analytics:read' }, async (_req, _principal, ctx) => overview(ctx));
