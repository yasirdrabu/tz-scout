import { listBuyingRoles } from '@/modules/accounts';
import { v1Route } from '../_lib/v1-route';

// GET /api/v1/buying-roles: the tenant's active buying roles, by sort, for the Add a person form.
export const GET = v1Route({ permission: 'accounts:read' }, async (_req, _principal, ctx) => ({ data: await listBuyingRoles(ctx) }));
