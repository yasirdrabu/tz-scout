import { summary } from '@/modules/analytics';
import { v1Route } from '../../_lib/v1-route';

/**
 * The Costs summary (R3a Ruling 11): tiles, categories with levels, and the last 6 months; plus cost per account
 * sent, cost per won account, return and the target (R3b-1 Ruling 12).
 */
export const GET = v1Route({ permission: 'costs:read' }, async (_req, _principal, ctx) => {
  const { spend90dCents, categories, ...s } = await summary(ctx);
  // `spend90dCents` would snake-case to `spend90d_cents`: these keys are named here.
  return {
    ...s,
    spend_90d_cents: spend90dCents,
    categories: categories.map(({ spend90dCents, ...c }) => ({ ...c, spend_90d_cents: spend90dCents })),
  };
});
