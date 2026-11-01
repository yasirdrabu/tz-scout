import { queueFacets } from '@/modules/routing';
import { v1Route } from '../../_lib/v1-route';
import { queueFilters } from '../filters';

/** Tier tab counts, filter option counts with names, the oldest arrival and the last review, for the same filters as the list. */
export const GET = v1Route({ permission: 'review:act' }, async (req, _principal, ctx) => queueFacets(ctx, queueFilters(new URL(req.url))));
