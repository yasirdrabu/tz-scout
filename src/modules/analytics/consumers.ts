import { CATEGORY_OF_PROVIDER } from '@/modules/integrations/contracts/costs';
import { usageRecorded } from '@/modules/integrations/contracts/events';
import { tenantTimezone } from '@/modules/tenancy';
import { defineConsumer, type ConsumerDef } from '@/platform/runtime/consumers';
import { dayOf } from './domain/budgets';
import { recordLine } from './services/lines';

/** Ruling 5: every priced paid call is one usage line, deduped on the event id. Lines come from nothing else. */
export const analyticsUsageLines = defineConsumer({
  name: 'analytics.usage_lines',
  event: usageRecorded,
  handle: async (e, ctx) => {
    const category = CATEGORY_OF_PROVIDER[e.data.provider];
    // A paid provider missing from the map would lose its money silently: fail, so the event is dead-lettered.
    if (!category) throw new Error(`Usage from provider "${e.data.provider}" has no cost category`);
    await recordLine(ctx, {
      originEventId: e.id,
      occurredOn: dayOf(new Date(e.data.occurredAt), await tenantTimezone(ctx)),
      category,
      provider: e.data.provider,
      amountCents: e.data.costCents,
      accountId: e.data.accountId,
    });
  },
});

/** Every analytics consumer, for the worker's list. */
export const analyticsConsumers: ConsumerDef[] = [analyticsUsageLines];
