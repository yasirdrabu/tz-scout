import { tenantCreated } from '@/modules/tenancy/contracts/events';
import { defineConsumer } from '@/platform/runtime/consumers';
import { seedScoringDefaults } from './defaults';

/** Gives a new tenant its default scoring profile and nightly ageing schedule. */
export const scoringTenantDefaults = defineConsumer({
  name: 'scoring.tenant_defaults',
  event: tenantCreated,
  handle: async (_e, ctx) => seedScoringDefaults(ctx),
});
