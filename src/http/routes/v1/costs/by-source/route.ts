import { costsBySource } from '@/modules/analytics';
import { v1Route } from '../../_lib/v1-route';

/** "Cost by source" over the last 90 days (R3b-1 Ruling 12): top-level sources by spend, then Shared costs. */
export const GET = v1Route({ permission: 'costs:read' }, async (_req, _principal, ctx) => costsBySource(ctx));
