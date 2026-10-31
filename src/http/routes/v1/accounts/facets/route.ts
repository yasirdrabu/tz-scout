import { accountFacets } from '@/modules/routing';
import { v1Route } from '../../_lib/v1-route';
import { accountFilters } from '../filters';

/** Stage tab counts, "{won} won this year" and the owner, practice and source options with counts, for the same filters as the list. */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => accountFacets(ctx, accountFilters(new URL(req.url))));
