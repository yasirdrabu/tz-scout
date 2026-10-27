import { tenantCreated } from '@/modules/tenancy/contracts/events';
import { defineConsumer } from '@/platform/runtime/consumers';
import { seedAccountDefaults } from './defaults';

/** Gives a new tenant its buying roles, exclusion rules and vendor phrases. */
export const accountsTenantDefaults = defineConsumer({
  name: 'accounts.tenant_defaults',
  event: tenantCreated,
  handle: async (_e, ctx) => seedAccountDefaults(ctx),
});
