import { tenantCreated } from '@/modules/tenancy/contracts/events';
import { defineConsumer } from '@/platform/runtime/consumers';
import { seedRoutingDefaults } from './defaults';

/** Gives a new tenant its review statuses, decline reasons, auto-accept setting and hourly schedule. */
export const routingTenantDefaults = defineConsumer({
  name: 'routing.tenant_defaults',
  event: tenantCreated,
  handle: async (_e, ctx) => seedRoutingDefaults(ctx),
});
