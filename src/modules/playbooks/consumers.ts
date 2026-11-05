import { getSummaries } from '@/modules/accounts';
import { accountMerged, factRecorded, personAdded, personUpdated, signalRecorded } from '@/modules/accounts/contracts/events';
import { activityObserved } from '@/modules/crm/contracts/events';
import { assignmentAccepted, assignmentCreated, assignmentDeclined, assignmentWithdrawn, reviewChanged } from '@/modules/routing/contracts/events';
import { accountScored } from '@/modules/scoring/contracts/events';
import { tenantCreated } from '@/modules/tenancy/contracts/events';
import type { ModuleContext } from '@/platform/context';
import { defineConsumer, type ConsumerDef } from '@/platform/runtime/consumers';
import { freezeBrief, readBrief, requestDraft, unfreezeBrief } from './services/brief';
import { seedPlaybooksDefaults } from './defaults';
import { onCrmActivity } from './services/crm-activity';
import { briefOnMerge } from './services/merge';
import { pauseOnWithdrawn, plansOnMerge, startPlan } from './services/start';

/** A redraft for an account that already has a brief (Ruling 2). */
const redraft = (ctx: ModuleContext, accountId: string) => requestDraft(ctx, accountId, { onlyExisting: true }).then(() => undefined);

/** Gives a new tenant its sweep schedule. */
export const playbooksTenantDefaults = defineConsumer({
  name: 'playbooks.tenant_defaults',
  event: tenantCreated,
  handle: async (_e, ctx) => seedPlaybooksDefaults(ctx),
});

/** Every score: the first gives the account its brief, later ones redraft (the event fires only when something changed). */
export const briefOnScored = defineConsumer({
  name: 'playbooks.brief_on_scored',
  event: accountScored,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => {
    await requestDraft(ctx, e.data.accountId);
  },
});

export const briefOnSignal = defineConsumer({
  name: 'playbooks.brief_on_signal',
  event: signalRecorded,
  orderedBy: (e) => e.data.accountId,
  handle: (e, ctx) => redraft(ctx, e.data.accountId),
});

/** Only a fact that became current changes what the brief reads. */
export const briefOnFact = defineConsumer({
  name: 'playbooks.brief_on_fact',
  event: factRecorded,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => {
    if (e.data.becameCurrent) await redraft(ctx, e.data.accountId);
  },
});

export const briefOnPersonAdded = defineConsumer({
  name: 'playbooks.brief_on_person_added',
  event: personAdded,
  orderedBy: (e) => e.data.accountId,
  handle: (e, ctx) => redraft(ctx, e.data.accountId),
});

export const briefOnPersonUpdated = defineConsumer({
  name: 'playbooks.brief_on_person_updated',
  event: personUpdated,
  orderedBy: (e) => e.data.accountId,
  handle: (e, ctx) => redraft(ctx, e.data.accountId),
});

/** A new lead offer (picked, or the best offer after a pick was cleared) redrafts for that offer. */
export const briefOnReviewChanged = defineConsumer({
  name: 'playbooks.brief_on_review_changed',
  event: reviewChanged,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => {
    const override = e.data.snapshot.leadOfferOverrideId;
    if (override === undefined) return;
    const row = await readBrief(ctx, e.data.accountId);
    if (!row || !row.draftedAt) return;
    const lead = override ?? (await getSummaries(ctx, [e.data.accountId]))[0]?.bestOfferId ?? null;
    if (lead !== row.offerId) await redraft(ctx, e.data.accountId);
  },
});

/** The brief the AE and HubSpot got stays put while the assignment is open. */
export const briefFreeze = defineConsumer({
  name: 'playbooks.brief_freeze',
  event: assignmentCreated,
  orderedBy: (e) => e.data.accountId,
  handle: (e, ctx) => freezeBrief(ctx, e.data.accountId, e.data.assignmentId, new Date(e.occurredAt)),
});

export const briefUnfreezeOnDeclined = defineConsumer({
  name: 'playbooks.brief_unfreeze',
  event: assignmentDeclined,
  orderedBy: (e) => e.data.accountId,
  handle: (e, ctx) => unfreezeBrief(ctx, e.data.accountId, e.data.assignmentId),
});

/** A withdrawal that a new assignment replaced keeps the brief frozen for the new AE. */
export const briefUnfreezeOnWithdrawn = defineConsumer({
  name: 'playbooks.brief_unfreeze_withdrawn',
  event: assignmentWithdrawn,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => {
    await unfreezeBrief(ctx, e.data.accountId, e.data.assignmentId, e.data.replacedBy);
  },
});

export const briefOnMerged = defineConsumer({
  name: 'playbooks.brief_on_merged',
  event: accountMerged,
  orderedBy: (e) => e.data.survivorId,
  handle: (e, ctx) => briefOnMerge(ctx, e.data.survivorId, e.data.mergedId),
});

/** Rulings 2 and 10: an accepted assignment starts the account's plan, or resumes its paused one. */
export const planOnAccepted = defineConsumer({
  name: 'playbooks.plan_on_accepted',
  event: assignmentAccepted,
  orderedBy: (e) => e.data.accountId,
  handle: (e, ctx) => startPlan(ctx, e),
});

/** A withdrawn assignment pauses its running plan. */
export const planPauseOnWithdrawn = defineConsumer({
  name: 'playbooks.plan_pause_on_withdrawn',
  event: assignmentWithdrawn,
  orderedBy: (e) => e.data.accountId,
  handle: (e, ctx) => pauseOnWithdrawn(ctx, e.data.assignmentId),
});

/** A merged account's plans move to the survivor. */
export const planOnMerged = defineConsumer({
  name: 'playbooks.plan_on_merged',
  event: accountMerged,
  orderedBy: (e) => e.data.survivorId,
  handle: (e, ctx) => plansOnMerge(ctx, e.data.survivorId, e.data.mergedId),
});

/** Rulings 13 and 14: a reply or meeting stops the plan by its rule; a task done in the CRM marks its step done. */
export const planOnCrmActivity = defineConsumer({
  name: 'playbooks.plan_on_crm_activity',
  event: activityObserved,
  orderedBy: (e) => e.data.accountId,
  handle: (e, ctx) => onCrmActivity(e, ctx),
});

/** Every playbooks consumer, for the worker's list. */
export const playbooksConsumers: ConsumerDef[] = [
  playbooksTenantDefaults,
  briefOnScored,
  briefOnSignal,
  briefOnFact,
  briefOnPersonAdded,
  briefOnPersonUpdated,
  briefOnReviewChanged,
  briefFreeze,
  briefUnfreezeOnDeclined,
  briefUnfreezeOnWithdrawn,
  briefOnMerged,
  planOnAccepted,
  planPauseOnWithdrawn,
  planOnMerged,
  planOnCrmActivity,
];
