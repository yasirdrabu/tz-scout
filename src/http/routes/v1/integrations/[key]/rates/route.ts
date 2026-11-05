import { z } from 'zod';
import { getRates, setRates } from '@/modules/integrations';
import { parseBody } from '../../../_lib/body';
import { v1Route } from '../../../_lib/v1-route';
import { MANAGE, integrationKey } from '../../key';

const body = z.strictObject({ rates: z.array(z.strictObject({ item: z.string(), cents_per_unit: z.number() })) });

/** R3a Ruling 1: each item the service is priced by, with `cents_per_unit` and whether it is the default. */
export const GET = v1Route({ permission: 'integrations:manage' }, async (req, _principal, ctx) => ({
  data: await getRates(ctx, integrationKey(req)),
}));

/** Saves the given rates (400 "A rate can't be negative." below 0); returns every rate, as GET does. */
export const PUT = v1Route(MANAGE, async (req, _principal, ctx) => {
  const key = integrationKey(req);
  const { rates } = await parseBody<z.infer<typeof body>>(req, body);
  await setRates(
    ctx,
    key,
    rates.map((r) => ({ item: r.item, centsPerUnit: r.cents_per_unit })),
  );
  return { data: await getRates(ctx, key) };
});
