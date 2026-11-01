import { z } from 'zod';
import { integration, setMode, type ConnectionMode } from '@/modules/integrations';
import { parseBody } from '../../../_lib/body';
import { v1Route } from '../../../_lib/v1-route';
import { MANAGE, integrationKey } from '../../key';

const body = z.strictObject({ mode: z.enum(['mock', 'live']) });

/** Live (409 `test-first` without a saved credential and a passing test in the last 10 minutes) or sample data. */
export const PUT = v1Route(MANAGE, async (req, _principal, ctx) => {
  const key = integrationKey(req);
  const { mode } = await parseBody<{ mode: ConnectionMode }>(req, body);
  await setMode(ctx, key, mode);
  return integration(ctx, key);
});
