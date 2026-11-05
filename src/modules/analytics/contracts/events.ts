// Events analytics publishes. The cost ledger publishes none of its own.
import { z } from 'zod';
import { COST_CATEGORIES, type CostCategory } from '@/modules/integrations/contracts/costs';
import { defineEvent } from '@/platform/events/registry';

const KEYS = COST_CATEGORIES.map((c) => c.key) as [CostCategory, ...CostCategory[]];

/**
 * R3a Ruling 8: a category's budget level for the current tenant month changed. Published only when the
 * stored level changes, in the same transaction as the line or budget that changed it. `budgetCents` is
 * null when the category has no budget. `seq` counts the category month's level changes (1, 2, ...), so a consumer
 * can tell an older event delivered late from the latest one.
 */
export const budgetLevelChanged = defineEvent(
  'analytics.budget.level_changed',
  1,
  z.object({
    category: z.enum(KEYS),
    month: z.string().regex(/^\d{4}-\d{2}$/),
    level: z.enum(['ok', 'alert', 'over', 'paused']),
    spentCents: z.number().int(),
    budgetCents: z.number().int().nullable(),
    seq: z.number().int().positive(),
  }),
);
