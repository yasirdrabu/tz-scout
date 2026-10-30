import { getAccount } from '@/modules/accounts';
import { accountCreated, accountUpdated } from '@/modules/accounts/contracts/events';
import { assignmentCreated } from '@/modules/routing/contracts/events';
import { tenantCreated } from '@/modules/tenancy/contracts/events';
import { defineConsumer } from '@/platform/runtime/consumers';
import { seedCrmDefaults } from './defaults';
import { queueCompanyCheck } from './services/checks';
import { queueHandoff } from './services/handoff';

/** Gives a new tenant its CRM setting, HubSpot field mapping and polling schedules. */
export const crmTenantDefaults = defineConsumer({
  name: 'crm.tenant_defaults',
  event: tenantCreated,
  handle: async (_e, ctx) => seedCrmDefaults(ctx),
});

/** A new account with a domain is checked against the CRM before review (Ruling 11). */
export const crmAccountCreated = defineConsumer({
  name: 'crm.account_created',
  event: accountCreated,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => queueCompanyCheck(ctx, e.data.accountId, e.data.domain),
});

/** A changed domain is checked again. */
export const crmAccountUpdated = defineConsumer({
  name: 'crm.account_updated',
  event: accountUpdated,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => {
    if (!e.data.changedKeys.includes('domain')) return;
    const account = await getAccount(ctx, e.data.accountId);
    if (account) await queueCompanyCheck(ctx, account.id, account.domain, { domainChanged: true });
  },
});

/** The push starts on assignment, not acceptance (CRM-E3-S1-AC3). */
export const crmAssignmentCreated = defineConsumer({
  name: 'crm.assignment_created',
  event: assignmentCreated,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => queueHandoff(ctx, e.data),
});

/** Every CRM consumer, for the worker's list. */
export const crmConsumers = [crmTenantDefaults, crmAccountCreated, crmAccountUpdated, crmAssignmentCreated];
