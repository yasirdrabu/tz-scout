import { resolveAccountId } from '@/modules/accounts';
import { accountMerged } from '@/modules/accounts/contracts/events';
import { dealChanged } from '@/modules/crm/contracts/events';
import { arrivalResolved } from '@/modules/intake/contracts/events';
import { CATEGORY_OF_PROVIDER } from '@/modules/integrations/contracts/costs';
import { usageRecorded } from '@/modules/integrations/contracts/events';
import { stageChanged } from '@/modules/routing/contracts/events';
import { accountScored } from '@/modules/scoring/contracts/events';
import { tenantTimezone } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { defineConsumer, type ConsumerDef } from '@/platform/runtime/consumers';
import { dayOf } from './domain/budgets';
import { mergeJourneys, recordArrival, recordDeal, recordScore, recordStage, stageKinds } from './services/journeys';
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
      sourceId: e.data.sourceId ?? null,
    });
  },
});

/**
 * The account an event is about, after any merge (a late event for a merged account lands on the survivor); an id
 * with no account row is kept as it is.
 */
const survivorOf = async (ctx: ModuleContext, accountId: string) => (await resolveAccountId(ctx, accountId))?.id ?? accountId;

/**
 * R3b-1 Ruling 2: the journey starts at the earliest arrival, from the chain's agent, else person, else vendor
 * source (as `arrival.closest_source_id`). An arrival naming no source has nothing to attribute to.
 */
export const analyticsJourneyArrival = defineConsumer({
  name: 'analytics.journey_arrival',
  event: arrivalResolved,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => {
    const c = e.data.sourceChain;
    const sourceId = c.agentSourceId ?? c.personSourceId ?? c.vendorSourceId;
    if (!sourceId) return;
    await recordArrival(ctx, { accountId: await survivorOf(ctx, e.data.accountId), sourceId, batchId: e.data.batchId ?? null, at: new Date(e.occurredAt) });
  },
});

/** Each stage entered, at the event's time; exits set and clear by the latest move (Ruling 2). */
export const analyticsJourneyStage = defineConsumer({
  name: 'analytics.journey_stage',
  event: stageChanged,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => {
    const kind = (await stageKinds(ctx)).get(e.data.to);
    await recordStage(ctx, { accountId: await survivorOf(ctx, e.data.accountId), stageKey: e.data.to, at: new Date(e.occurredAt), kind });
  },
});

/** The practice and best offer scoring picked; an older score (by `version`) delivered late is ignored. */
export const analyticsJourneyScore = defineConsumer({
  name: 'analytics.journey_score',
  event: accountScored,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) =>
    recordScore(ctx, {
      accountId: await survivorOf(ctx, e.data.accountId),
      practiceId: e.data.practiceId,
      offerId: e.data.bestOfferId,
      version: e.data.version,
    }),
});

/** Each deal's latest state, by `observedAt`. */
export const analyticsJourneyDeal = defineConsumer({
  name: 'analytics.journey_deal',
  event: dealChanged,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) =>
    recordDeal(ctx, {
      accountId: await survivorOf(ctx, e.data.accountId),
      system: e.data.system,
      dealExternalId: e.data.dealExternalId,
      status: e.data.status,
      amountCents: e.data.amountCents,
      closedAt: e.data.closedAt ? new Date(e.data.closedAt) : null,
      observedAt: new Date(e.data.observedAt),
    }),
});

/** The merged account's journey folds into the survivor's. */
export const analyticsJourneyMerge = defineConsumer({
  name: 'analytics.journey_merge',
  event: accountMerged,
  orderedBy: (e) => e.data.survivorId,
  handle: async (e, ctx) => mergeJourneys(ctx, e.data.survivorId, e.data.mergedId),
});

/** Every analytics consumer, for the worker's list. */
export const analyticsConsumers: ConsumerDef[] = [
  analyticsUsageLines,
  analyticsJourneyArrival,
  analyticsJourneyStage,
  analyticsJourneyScore,
  analyticsJourneyDeal,
  analyticsJourneyMerge,
];
