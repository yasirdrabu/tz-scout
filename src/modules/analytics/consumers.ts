import { CATEGORY_OF_PROVIDER } from '@/modules/integrations/contracts/costs';
import { usageRecorded } from '@/modules/integrations/contracts/events';
import { tenantTimezone } from '@/modules/tenancy';
import { log } from '@/platform/log';
import { defineConsumer, type ConsumerDef } from '@/platform/runtime/consumers';
import { recordLine } from './services/lines';

/** The tenant-timezone date (YYYY-MM-DD) of an instant. */
const dayIn = (at: string, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(at));

/** Ruling 5: every priced paid call is one usage line, deduped on the event id. Lines come from nothing else. */
export const analyticsUsageLines = defineConsumer({
  name: 'analytics.usage_lines',
  event: usageRecorded,
  handle: async (e, ctx) => {
    const category = CATEGORY_OF_PROVIDER[e.data.provider];
    if (!category) {
      log.warn({ tenantId: ctx.tenantId, provider: e.data.provider, eventId: e.id }, 'analytics: usage from a provider with no cost category, no line');
      return;
    }
    await recordLine(ctx, {
      originEventId: e.id,
      occurredOn: dayIn(e.data.occurredAt, await tenantTimezone(ctx)),
      category,
      provider: e.data.provider,
      amountCents: e.data.costCents,
      accountId: e.data.accountId,
    });
  },
});

/** Every analytics consumer, for the worker's list. */
export const analyticsConsumers: ConsumerDef[] = [analyticsUsageLines];
