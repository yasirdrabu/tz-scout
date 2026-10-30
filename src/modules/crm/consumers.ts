import { getAccount } from '@/modules/accounts';
import { accountCreated, accountUpdated, personAdded } from '@/modules/accounts/contracts/events';
import { assignmentCreated, assignmentDeclined, assignmentWithdrawn } from '@/modules/routing/contracts/events';
import { tenantCreated } from '@/modules/tenancy/contracts/events';
import { defineConsumer } from '@/platform/runtime/consumers';
import { seedCrmDefaults } from './defaults';
import { queueCompanyCheck } from './services/checks';
import { queueHandoff } from './services/handoff';
import { queuePersonPush } from './services/push';
import { requestUndo } from './services/undo';

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

/** A seller's decline undoes the handoff (CRM-E3-S7). Ordered by account, so it comes after the assignment's own event. */
export const crmAssignmentDeclined = defineConsumer({
  name: 'crm.assignment_declined',
  event: assignmentDeclined,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) =>
    requestUndo(ctx, { assignmentId: e.data.assignmentId, kind: 'declined', reasonLabel: e.data.reasonLabel ?? e.data.reasonKey, by: e.data.sellerUserId }),
});

/** A withdrawal undoes the handoff too; on a reassign the new assignment pushes again on its own. */
export const crmAssignmentWithdrawn = defineConsumer({
  name: 'crm.assignment_withdrawn',
  event: assignmentWithdrawn,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => requestUndo(ctx, { assignmentId: e.data.assignmentId, kind: 'withdrawn', reasonLabel: null, by: e.data.by }),
});

/** A person added to a handed-off account goes to the CRM too (Ruling 22). */
export const crmPersonAdded = defineConsumer({
  name: 'crm.person_added',
  event: personAdded,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => queuePersonPush(ctx, e.data.accountId, e.data.personId),
});

/** Every CRM consumer, for the worker's list. */
export const crmConsumers = [
  crmTenantDefaults,
  crmAccountCreated,
  crmAccountUpdated,
  crmAssignmentCreated,
  crmAssignmentDeclined,
  crmAssignmentWithdrawn,
  crmPersonAdded,
];
