import { tenantCreated } from '@/modules/tenancy/contracts/events';
import { defineConsumer } from '@/platform/runtime/consumers';
import { seedCrmDefaults } from './defaults';

/** Gives a new tenant its CRM setting, HubSpot field mapping and polling schedules. */
export const crmTenantDefaults = defineConsumer({
  name: 'crm.tenant_defaults',
  event: tenantCreated,
  handle: async (_e, ctx) => seedCrmDefaults(ctx),
});

/** Every CRM consumer, for the worker's list. */
export const crmConsumers = [crmTenantDefaults];
