import { disconnect, integration, testConnection } from '@/modules/integrations';
import { scrubError } from '@/platform/scrub-error';
import { idAndAction } from '../../_lib/path';
import { byAction, v1Route } from '../../_lib/v1-route';
import { MANAGE } from '../key';

// POST /v1/integrations/{key}:test and :disconnect
export const POST = byAction('integrations', {
  /** Runs the service's test (live when a credential is saved): `{ok, message, missing_permissions?, facts?, duration_ms}`. */
  test: v1Route(MANAGE, async (req, _principal, ctx) => {
    const result = await testConnection(ctx, idAndAction(req, 'integrations').id);
    return { ...result, message: scrubError(result.message) };
  }),
  /** Clears the saved credentials and goes back to sample data. */
  disconnect: v1Route(MANAGE, async (req, _principal, ctx) => {
    const { id } = idAndAction(req, 'integrations');
    await disconnect(ctx, id);
    return integration(ctx, id);
  }),
});
