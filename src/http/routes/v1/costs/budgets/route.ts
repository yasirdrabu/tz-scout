import { z } from 'zod';
import { getBudgets, saveBudgets } from '@/modules/analytics';
import type { CostCategory } from '@/modules/integrations/contracts/costs';
import { parseBody } from '../../_lib/body';
import { v1Route } from '../../_lib/v1-route';

/** The service checks the values and words the errors. */
const saveBody = z.strictObject({
  month: z.string(),
  budgets: z.array(z.strictObject({ category: z.string(), amount_cents: z.number().int() })),
});

/** Each category's budget for `?month=` (YYYY-MM, the current tenant month by default), carried forward. */
export const GET = v1Route({ permission: 'costs:read' }, async (req, _principal, ctx) => getBudgets(ctx, new URL(req.url).searchParams.get('month') || undefined));

/** `{ month, budgets: [{ category, amount_cents }] }`: the current or a future month; a past month is a 409. */
export const PUT = v1Route({ permission: 'budgets:write' }, async (req, _principal, ctx) => {
  const { month, budgets } = await parseBody<{ month: string; budgets: { category: string; amount_cents: number }[] }>(req, saveBody);
  return saveBudgets(
    ctx,
    month,
    budgets.map((b) => ({ category: b.category as CostCategory, amountCents: b.amount_cents })),
  );
});
