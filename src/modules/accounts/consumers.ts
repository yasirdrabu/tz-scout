import { accountScored } from '@/modules/scoring/contracts/events';
import { tenantCreated } from '@/modules/tenancy/contracts/events';
import { defineConsumer } from '@/platform/runtime/consumers';
import { seedAccountDefaults } from './defaults';
import { applyScore } from './services/summary';

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
