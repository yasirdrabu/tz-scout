import { companyChecked, dealChanged, handoffCompleted } from '@/modules/crm/contracts/events';
import type { ModuleContext } from '@/platform/context';
import type { CrmStatus } from './contracts/types';
import { accountScored } from '@/modules/scoring/contracts/events';
import { reviewChanged } from '@/modules/routing/contracts/events';
import { tenantCreated } from '@/modules/tenancy/contracts/events';
import { defineConsumer } from '@/platform/runtime/consumers';
import { seedAccountDefaults } from './defaults';
import { applyCrmStatus } from './services/exclusion';
import { lockAccount } from './services/lock';
import { resolveAccountId } from './services/match';
import { applyReview, applyScore } from './services/summary';

/** Gives a new tenant its buying roles, exclusion rules and vendor phrases. */
export const accountsTenantDefaults = defineConsumer({
  name: 'accounts.tenant_defaults',
  event: tenantCreated,
  handle: async (_e, ctx) => seedAccountDefaults(ctx),
});

/** Keeps the account summary's score columns current. Only the version check orders events; `orderedBy` just stops two deliveries for one account running at once. */
export const accountsSummaryOnScored = defineConsumer({
  name: 'accounts.summary_on_scored',
  event: accountScored,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => {
    const { accountId, priority, fit, intent, tier, bestOfferId, practiceId, version } = e.data;
    await applyScore(ctx, accountId, { priority, fit, intent, tier, bestOfferId, practiceId, version });
  },
});

/** Keeps the account summary's review columns current from routing's whole-state snapshot. */
export const accountsSummaryOnReviewChanged = defineConsumer({
  name: 'accounts.summary_on_review_changed',
  event: reviewChanged,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => applyReview(ctx, e.data.accountId, e.data.snapshot, e.data.version),
});

/** Sets `crm_status` from a CRM event if it is newer than the stored one. A merged or unknown id is ignored (the survivor gets its own event). */
async function crmStatusFrom(ctx: ModuleContext, accountId: string, status: CrmStatus, observedAt: string): Promise<void> {
  await lockAccount(ctx, accountId);
  const resolved = await resolveAccountId(ctx, accountId);
  if (!resolved || resolved.mergedInto) return;
  await applyCrmStatus(ctx, accountId, status, new Date(observedAt));
}

/** Keeps `account.crm_status` current from the CRM check, a completed handoff and a deal change (Ruling 12). */
export const accountsCrmStatusOnChecked = defineConsumer({
  name: 'accounts.crm_status',
  event: companyChecked,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => crmStatusFrom(ctx, e.data.accountId, e.data.companyLifecycle, e.data.observedAt),
});

export const accountsCrmStatusOnHandoff = defineConsumer({
  name: 'accounts.crm_status_on_handoff',
  event: handoffCompleted,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => crmStatusFrom(ctx, e.data.accountId, e.data.companyLifecycle, e.data.observedAt),
});

export const accountsCrmStatusOnDeal = defineConsumer({
  name: 'accounts.crm_status_on_deal',
  event: dealChanged,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => crmStatusFrom(ctx, e.data.accountId, e.data.companyLifecycle, e.data.observedAt),
});

export const accountsCrmStatusConsumers = [accountsCrmStatusOnChecked, accountsCrmStatusOnHandoff, accountsCrmStatusOnDeal];
