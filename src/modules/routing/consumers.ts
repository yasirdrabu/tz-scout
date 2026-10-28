import { accountMerged } from '@/modules/accounts/contracts/events';
import { arrivalResolved } from '@/modules/intake/contracts/events';
import { memberRemoved, tenantCreated } from '@/modules/tenancy/contracts/events';
import { defineConsumer } from '@/platform/runtime/consumers';
import { seedRoutingDefaults } from './defaults';
import { reviewOnArrival, reviewOnMerge } from './services/review';
import { withdrawForRemovedMember } from './services/respond';

/** Gives a new tenant its review statuses, decline reasons, auto-accept setting and hourly schedule. */
export const routingTenantDefaults = defineConsumer({
  name: 'routing.tenant_defaults',
  event: tenantCreated,
  handle: async (_e, ctx) => seedRoutingDefaults(ctx),
});

/** A resolved arrival gives its account a review row, or flags an assigned account "New from" (Rulings 5 and 7). */
export const routingArrivalResolved = defineConsumer({
  name: 'routing.arrival_resolved',
  event: arrivalResolved,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) =>
    reviewOnArrival(ctx, { accountId: e.data.accountId, initialReviewStatusKey: e.data.initialReviewStatusKey, sourceChain: e.data.sourceChain, at: e.occurredAt }),
});

/** The survivor keeps its review; the merged account's assignment and history move to it. */
export const routingAccountMerged = defineConsumer({
  name: 'routing.account_merged',
  event: accountMerged,
  orderedBy: (e) => e.data.survivorId,
  handle: async (e, ctx) => reviewOnMerge(ctx, e.data.survivorId, e.data.mergedId, e.data.mergedBy, e.id),
});

/** A removed member's open assignments are withdrawn, so their accounts go back to the leader. */
export const routingMemberRemoved = defineConsumer({
  name: 'routing.member_removed',
  event: memberRemoved,
  handle: async (e, ctx) => withdrawForRemovedMember(ctx, e.data.userId, e.data.removedBy),
});

/** Every routing consumer, for the worker's list. */
export const routingConsumers = [routingTenantDefaults, routingArrivalResolved, routingAccountMerged, routingMemberRemoved];
