import { z } from 'zod';
import { integration, setDisabled } from '@/modules/integrations';
import { parseBody } from '../../../_lib/body';
import { v1Route } from '../../../_lib/v1-route';
import { MANAGE, integrationKey } from '../../key';

const body = z.strictObject({ disabled: z.boolean() });

/** Turns the service off (calls to it are refused) or back on. */
export const PUT = v1Route(MANAGE, async (req, _principal, ctx) => {
  const key = integrationKey(req);
  const { disabled } = await parseBody<{ disabled: boolean }>(req, body);
  await setDisabled(ctx, key, disabled);
  return integration(ctx, key);
});
