import { budgetLevelChanged } from '@/modules/analytics/contracts/events';
import { defineConsumer, type ConsumerDef } from '@/platform/runtime/consumers';
import { PAUSABLE } from './contracts/costs';
import { paidPause } from './db/schema';

/**
 * R3a Ruling 9: a pausable category's level for a tenant month becomes its `paid_pause` flag. `paused` sets it;
 * any lower level (the budget raised, a line voided) clears it, so waiting calls run on their next try.
 */
export const integrationsBudgetPause = defineConsumer({
  name: 'integrations.budget_pause',
  event: budgetLevelChanged,
  orderedBy: (e) => `${e.data.category}:${e.data.month}`,
  handle: async (e, ctx) => {
    const { category, month, level } = e.data;
    if (!PAUSABLE.has(category)) return;
    const paused = level === 'paused';
    await ctx.tx
      .insert(paidPause)
      .values({ tenantId: ctx.tenantId, category, month, paused })
      .onConflictDoUpdate({ target: [paidPause.tenantId, paidPause.category, paidPause.month], set: { paused } });
  },
});

/** Every integrations consumer, for the worker's list. */
export const integrationsConsumers: ConsumerDef[] = [integrationsBudgetPause];
