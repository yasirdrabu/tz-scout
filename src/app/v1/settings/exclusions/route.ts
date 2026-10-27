import { listExclusionLists, listExclusionRules } from '@/modules/accounts';
import { v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

export const GET = v1Route({ permission: 'settings:manage' }, async (_req, _principal, ctx) => ({
  rules: await listExclusionRules(ctx),
  lists: await listExclusionLists(ctx),
}));
