import { getAccount } from '@/modules/accounts';
import { accountCreated, accountMerged, accountUpdated, personAdded, personUpdated } from '@/modules/accounts/contracts/events';
import { assignmentCreated, assignmentDeclined, assignmentWithdrawn } from '@/modules/routing/contracts/events';
import { tenantCreated } from '@/modules/tenancy/contracts/events';
import type { ModuleContext } from '@/platform/context';
import { defineConsumer } from '@/platform/runtime/consumers';
import { seedCrmDefaults } from './defaults';
import { queueCompanyCheck } from './services/checks';
import { queueHandoff } from './services/handoff';
import { linkExternalIds } from './services/links';
import { moveCrmToSurvivor } from './services/merge';
import { queuePersonPush } from './services/push';
import { requestUndo } from './services/undo';

/** Gives a new tenant its CRM setting, HubSpot field mapping and polling schedules. */
export const crmTenantDefaults = defineConsumer({
  name: 'crm.tenant_defaults',
  event: tenantCreated,
  handle: async (_e, ctx) => seedCrmDefaults(ctx),
});

/** Links the account or person to the CRM ids that arrived with it (CRM-E6-S2). */
const linkIds = (ctx: ModuleContext, data: { accountId: string; personId?: string; externalIds?: { system: string; id: string }[] }) =>
  data.externalIds?.length ? linkExternalIds(ctx, { accountId: data.accountId, personId: data.personId, externalIds: data.externalIds }) : Promise.resolve();

/** A new account is linked to the CRM ids it arrived with, and one with a domain is checked against the CRM before review (Ruling 11). */
export const crmAccountCreated = defineConsumer({
  name: 'crm.account_created',
  event: accountCreated,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => {
    await linkIds(ctx, e.data);
    await queueCompanyCheck(ctx, e.data.accountId, e.data.domain);
  },
});

/** New CRM ids are linked; a changed domain is checked again. */
export const crmAccountUpdated = defineConsumer({
  name: 'crm.account_updated',
  event: accountUpdated,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => {
    await linkIds(ctx, e.data);
    if (!e.data.changedKeys.includes('domain')) return;
    const account = await getAccount(ctx, e.data.accountId);
    if (account) await queueCompanyCheck(ctx, account.id, account.domain, { domainChanged: true });
  },
});

// `orderedBy` keeps two deliveries for one account from running at once; it does not order events of different
// types. A decline or withdrawal may be handled before the assignment's `created`, so each side copes with the
// other coming first (final review I1).

/**
 * The push starts on assignment, not acceptance (CRM-E3-S1-AC3). A reassign first requests the undo of the
 * assignment it replaces (the same idempotent request the withdrawal makes), so the new push sees the replaced
 * seller's handoff as undo-requested even when the withdrawal is handled later.
 */
export const crmAssignmentCreated = defineConsumer({
  name: 'crm.assignment_created',
  event: assignmentCreated,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => {
    const d = e.data;
    if (d.previousAssignmentId) {
      await requestUndo(ctx, { assignmentId: d.previousAssignmentId, accountId: d.accountId, kind: 'withdrawn', reasonLabel: null, by: d.assignedBy });
    }
    await queueHandoff(ctx, d);
  },
});

/** A seller's decline undoes the handoff (CRM-E3-S7); one handled before the assignment's `created` leaves a cancelled handoff. */
export const crmAssignmentDeclined = defineConsumer({
  name: 'crm.assignment_declined',
  event: assignmentDeclined,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) =>
    requestUndo(ctx, {
      assignmentId: e.data.assignmentId,
      accountId: e.data.accountId,
      sellerUserId: e.data.sellerUserId,
      kind: 'declined',
      reasonLabel: e.data.reasonLabel ?? e.data.reasonKey,
      by: e.data.sellerUserId,
    }),
});

/** A withdrawal undoes the handoff too; on a reassign the new assignment pushes again on its own. */
export const crmAssignmentWithdrawn = defineConsumer({
  name: 'crm.assignment_withdrawn',
  event: assignmentWithdrawn,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => requestUndo(ctx, { assignmentId: e.data.assignmentId, accountId: e.data.accountId, kind: 'withdrawn', reasonLabel: null, by: e.data.by }),
});

/** A new person is linked to the CRM ids they arrived with; one added to a handed-off account goes to the CRM too (Ruling 22). */
export const crmPersonAdded = defineConsumer({
  name: 'crm.person_added',
  event: personAdded,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => {
    await linkIds(ctx, e.data);
    await queuePersonPush(ctx, e.data.accountId, e.data.personId);
  },
});

/** A known person who arrives with new CRM ids is linked to them. */
export const crmPersonUpdated = defineConsumer({
  name: 'crm.person_updated',
  event: personUpdated,
  orderedBy: (e) => e.data.accountId,
  handle: async (e, ctx) => linkIds(ctx, e.data),
});

/** Links, handoffs, deals, activities and checks follow an account merge to the survivor. */
export const crmAccountMerged = defineConsumer({
  name: 'crm.account_merged',
  event: accountMerged,
  orderedBy: (e) => e.data.survivorId,
  handle: async (e, ctx) => moveCrmToSurvivor(ctx, e.data.survivorId, e.data.mergedId),
});

/** Every CRM consumer, for the worker's list. */
export const crmConsumers = [
  crmTenantDefaults,
  crmAccountCreated,
  crmAccountUpdated,
  crmAccountMerged,
  crmAssignmentCreated,
  crmAssignmentDeclined,
  crmAssignmentWithdrawn,
  crmPersonAdded,
  crmPersonUpdated,
];
