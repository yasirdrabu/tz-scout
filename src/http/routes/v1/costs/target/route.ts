import { z } from 'zod';
import { setTarget } from '@/modules/analytics';
import { parseBody } from '../../_lib/body';
import { v1Route } from '../../_lib/v1-route';

/** The service checks the value and words the error. */
const targetBody = z.strictObject({ target_cost_per_won_cents: z.number().nullable() });

/** `{ target_cost_per_won_cents }` (people only, R3b-1 Ruling 8): 1 or more, or null to clear it. */
export const PUT = v1Route({ permission: 'budgets:write', peopleOnly: true }, async (req, _principal, ctx) => {
  const { targetCostPerWonCents } = await parseBody<{ targetCostPerWonCents: number | null }>(req, targetBody);
  return { targetCostPerWonCents: await setTarget(ctx, targetCostPerWonCents) };
});
