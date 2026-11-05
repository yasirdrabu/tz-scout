import { summary } from '@/modules/analytics';
import { v1Route } from '../../_lib/v1-route';

/** The Costs summary (R3a Ruling 11): tiles, categories with levels, and the last 6 months. */
export const GET = v1Route({ permission: 'costs:read' }, async (_req, _principal, ctx) => {
  const s = await summary(ctx);
  // `spend90dCents` would snake-case to `spend90d_cents`: these keys are named here.
  return {
    month: s.month,
    spendMonthCents: s.spendMonthCents,
    budgetMonthCents: s.budgetMonthCents,
    spend_90d_cents: s.spend90dCents,
    categories: s.categories.map(({ spend90dCents, ...c }) => ({ ...c, spend_90d_cents: spend90dCents })),
    months: s.months,
  };
});
