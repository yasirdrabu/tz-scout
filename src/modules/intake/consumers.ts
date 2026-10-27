import { tenantCreated } from '@/modules/tenancy/contracts/events';
import { defineConsumer } from '@/platform/runtime/consumers';
import { seedIntakeDefaults } from './defaults';

/** Gives a new tenant its vendor sources, relationship defaults and waiting-expiry schedule. */
export const intakeTenantDefaults = defineConsumer({
  name: 'intake.tenant_defaults',
  event: tenantCreated,
  handle: async (_e, ctx) => seedIntakeDefaults(ctx),
});
