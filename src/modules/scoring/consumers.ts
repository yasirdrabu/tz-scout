import { and, eq } from 'drizzle-orm';
import {
  accountCreated,
  accountExclusionChanged,
  accountMerged,
  accountUpdated,
  factRecorded,
  personAdded,
  personUpdated,
  signalRecorded,
} from '@/modules/accounts/contracts/events';
import { arrivalRejected, arrivalResolved, sourceTrustChanged } from '@/modules/intake/contracts/events';
import { getOffer } from '@/modules/offers';
import { offerApproved, offerArchived, offerChanged } from '@/modules/offers/contracts/events';
import { tenantCreated } from '@/modules/tenancy/contracts/events';
import { ScoutError } from '@/platform/errors';
import type { EventDef } from '@/platform/events/registry';
import { defineConsumer } from '@/platform/runtime/consumers';
import { rulesChanged } from './contracts/events';
import type { ScoreCause } from './contracts/types';
import { seedScoringDefaults } from './defaults';
import { accountScore, offerMatch } from './db/schema';
import { startRescore } from './services/rescore';
import { scoreAccount } from './services/score';

/** Gives a new tenant its default scoring profile and nightly ageing schedule. */
export const scoringTenantDefaults = defineConsumer({
  name: 'scoring.tenant_defaults',
  event: tenantCreated,
  handle: async (_e, ctx) => seedScoringDefaults(ctx),
});

/**
 * Scores the event's account. Accounts events from an arrival upsert carry `arrivalId` and are skipped,
 * because `intake.arrival.resolved` (or `rejected`) scores that account once for the whole arrival (Ruling 11).
 */
function scoreOnAccountEvent<D extends { accountId: string; arrivalId?: string | undefined }>(name: string, event: EventDef<D>, cause: ScoreCause) {
  return defineConsumer({
    name: `scoring.${name}`,
    event,
    orderedBy: (e) => e.data.accountId,
    handle: async (e, ctx) => {
      if (e.data.arrivalId) return;
      await scoreAccount(ctx, e.data.accountId, cause, e.id);
    },
  });
}

export const scoreOnAccountCreated = scoreOnAccountEvent('account_created', accountCreated, 'new_fact');
export const scoreOnAccountUpdated = scoreOnAccountEvent('account_updated', accountUpdated, 'new_fact');
export const scoreOnFactRecorded = scoreOnAccountEvent('fact_recorded', factRecorded, 'new_fact');
export const scoreOnSignalRecorded = scoreOnAccountEvent('signal_recorded', signalRecorded, 'new_signal');
export const scoreOnPersonAdded = scoreOnAccountEvent('person_added', personAdded, 'new_fact');
export const scoreOnPersonUpdated = scoreOnAccountEvent('person_updated', personUpdated, 'new_fact');
export const scoreOnExclusionChanged = scoreOnAccountEvent('exclusion_changed', accountExclusionChanged, 'new_fact');

/** A resolved arrival scores its account once, whatever the arrival added (a warm intro is its own cause). */
export const scoreOnArrivalResolved = defineConsumer({
  name: 'scoring.arrival_resolved',
  event: arrivalResolved,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => {
    await scoreAccount(ctx, e.data.accountId, e.data.warmIntro ? 'warm_intro' : 'new_fact', e.id);
  },
});

/** An arrival rejected as excluded still upserted its account, so that account is scored. */
export const scoreOnArrivalRejected = defineConsumer({
  name: 'scoring.arrival_rejected',
  event: arrivalRejected,
  orderedBy: (e) => e.data.accountId ?? e.data.arrivalId,
  handle: async (e, ctx) => {
    if (e.data.accountId) await scoreAccount(ctx, e.data.accountId, 'new_fact', e.id);
  },
});

/**
 * After a merge the survivor is scored with the warm intro and source chains of both ids, and the merged
 * account's score and matches are deleted. Its `score_change` history stays, as a record of what it was.
 */
export const scoringAccountMerged = defineConsumer({
  name: 'scoring.account_merged',
  event: accountMerged,
  orderedBy: (e) => e.data.survivorId,
  handle: async (e, ctx) => {
    const { survivorId, mergedId } = e.data;
    await scoreAccount(ctx, survivorId, 'new_fact', e.id, { alsoAccountIds: [mergedId] });
    await ctx.tx.delete(offerMatch).where(and(eq(offerMatch.tenantId, ctx.tenantId), eq(offerMatch.accountId, mergedId)));
    await ctx.tx.delete(accountScore).where(and(eq(accountScore.tenantId, ctx.tenantId), eq(accountScore.accountId, mergedId)));
  },
});

const practiceAndUnassigned = (practiceId: string) => ({ practiceId, includeNoPractice: true });

/** A newly approved offer can win for accounts in its practice and for accounts with no practice. */
export const rescoreOnOfferApproved = defineConsumer({
  name: 'scoring.rescore_offer_approved',
  event: offerApproved,
  handle: async (e, ctx) => {
    await startRescore(ctx, practiceAndUnassigned(e.data.practiceId), 'offer_changed');
  },
});

/** Accounts that hold a match for an archived offer lose it. */
export const rescoreOnOfferArchived = defineConsumer({
  name: 'scoring.rescore_offer_archived',
  event: offerArchived,
  handle: async (e, ctx) => {
    await startRescore(ctx, { offerId: e.data.offerId }, 'offer_changed');
  },
});

/** Accounts holding a match are rescored; when the offer is still approved, so are those it may newly fit. */
export const rescoreOnOfferChanged = defineConsumer({
  name: 'scoring.rescore_offer_changed',
  event: offerChanged,
  handle: async (e, ctx) => {
    if (!e.data.affectsMatching) return;
    await startRescore(ctx, { offerId: e.data.offerId }, 'offer_changed');
    // An offer that can no longer be read is treated as not approved.
    const stillApproved = await getOffer(ctx, e.data.offerId).then(
      (o) => o.status === 'approved',
      (err: unknown) => {
        if (err instanceof ScoutError && err.status === 404) return false;
        throw err;
      },
    );
    if (stillApproved) await startRescore(ctx, practiceAndUnassigned(e.data.practiceId), 'offer_changed');
  },
});

/** A changed profile can move every account. */
export const rescoreOnRulesChanged = defineConsumer({
  name: 'scoring.rescore_rules_changed',
  event: rulesChanged,
  handle: async (_e, ctx) => {
    await startRescore(ctx, {}, 'rules_changed');
  },
});

/** A source's trust moves only the accounts it brought in. */
export const rescoreOnTrustChanged = defineConsumer({
  name: 'scoring.rescore_trust_changed',
  event: sourceTrustChanged,
  handle: async (e, ctx) => {
    await startRescore(ctx, { sourceId: e.data.sourceId }, 'trust_changed');
  },
});

/** Every scoring consumer, for the worker's list. */
export const scoringConsumers = [
  scoringTenantDefaults,
  scoreOnAccountCreated,
  scoreOnAccountUpdated,
  scoreOnFactRecorded,
  scoreOnSignalRecorded,
  scoreOnPersonAdded,
  scoreOnPersonUpdated,
  scoreOnExclusionChanged,
  scoreOnArrivalResolved,
  scoreOnArrivalRejected,
  scoringAccountMerged,
  rescoreOnOfferApproved,
  rescoreOnOfferArchived,
  rescoreOnOfferChanged,
  rescoreOnRulesChanged,
  rescoreOnTrustChanged,
];
