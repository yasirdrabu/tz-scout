import { listIntegrations } from '@/modules/integrations';
import { v1Route } from '../_lib/v1-route';

/** Every service the workspace connects: mode, status, today's usage and the saved credentials (last 4 only). */
export const GET = v1Route({ permission: 'integrations:manage' }, async (_req, _principal, ctx) => ({
  data: await listIntegrations(ctx),
}));
