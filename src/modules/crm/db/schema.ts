import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { HandoffUndone } from '../contracts/types';

/**
 * CRM schema (CRM sync). Every table here is a tenant table: `tenant_id` not null, row level security
 * enabled and forced with the standard `tenant_isolation` policy (added by hand in the migration).
 */
export const crm = pgSchema('crm');

const at = (name: string) => timestamp(name, { withTimezone: true });

/** One row per Scout record per CRM record. */
export const link = crm.table(
  'link',
  {
    id: text('id').primaryKey(), // lnk_
    tenantId: text('tenant_id').notNull(),
    scoutType: text('scout_type').notNull(), // account | person | note | task | deal | owner
    scoutId: text('scout_id').notNull(),
    system: text('system').notNull(),
    externalId: text('external_id').notNull(),
    fingerprint: text('fingerprint'),
    lastSyncedAt: at('last_synced_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('link_uq').on(t.tenantId, t.system, t.scoutType, t.scoutId, t.externalId),
    index('link_external_idx').on(t.tenantId, t.system, t.externalId),
  ],
);

export const handoffBatch = crm.table(
  'handoff_batch',
  {
    id: text('id').primaryKey(), // hbt_
    tenantId: text('tenant_id').notNull(),
    bulkKey: text('bulk_key'),
    name: text('name').notNull().default(''),
    createdBy: text('created_by').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('handoff_batch_bulk_key_uq').on(t.tenantId, t.bulkKey).where(sql`${t.bulkKey} is not null`)],
);

/** One per push. A re-push is a new row. */
export const handoff = crm.table(
  'handoff',
  {
    id: text('id').primaryKey(), // hof_
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    assignmentId: text('assignment_id').notNull(),
    handoffBatchId: text('handoff_batch_id'),
    system: text('system').notNull(),
    status: text('status').notNull().default('queued'), // queued | running | completed | needs_decision | failed | cancelled
    attempts: integer('attempts').notNull().default(0),
    ownershipAction: text('ownership_action').notNull(), // assign | keep
    takenFromOwner: text('taken_from_owner'),
    ownerExternalId: text('owner_external_id'),
    companyExternalId: text('company_external_id'),
    decisionReason: text('decision_reason'),
    lastError: text('last_error'),
    cancelRequestedAt: at('cancel_requested_at'),
    undone: jsonb('undone').$type<HandoffUndone>(),
    queuedAt: at('queued_at').notNull().defaultNow(),
    completedAt: at('completed_at'),
  },
  (t) => [
    uniqueIndex('handoff_assignment_uq').on(t.tenantId, t.assignmentId),
    index('handoff_account_idx').on(t.tenantId, t.accountId, t.queuedAt),
    index('handoff_batch_idx').on(t.tenantId, t.handoffBatchId),
    check('handoff_status_valid', sql`${t.status} in ('queued', 'running', 'completed', 'needs_decision', 'failed', 'cancelled')`),
    check('handoff_ownership_action_valid', sql`${t.ownershipAction} in ('assign', 'keep')`),
  ],
);

/** One message per seller per batch. */
export const handoffMessage = crm.table(
  'handoff_message',
  {
    id: text('id').primaryKey(), // hmg_
    tenantId: text('tenant_id').notNull(),
    handoffBatchId: text('handoff_batch_id').notNull(),
    sellerUserId: text('seller_user_id').notNull(),
    count: integer('count').notNull().default(0),
    text: text('text').notNull().default(''),
    copiedAt: at('copied_at'),
    sentAt: at('sent_at'),
  },
  (t) => [uniqueIndex('handoff_message_uq').on(t.tenantId, t.handoffBatchId, t.sellerUserId)],
);

/** The CRM's owner roster, active and former. */
export const owner = crm.table(
  'owner',
  {
    id: text('id').primaryKey(), // cow_
    tenantId: text('tenant_id').notNull(),
    system: text('system').notNull(),
    externalOwnerId: text('external_owner_id').notNull(),
    name: text('name').notNull(),
    email: text('email'),
    active: boolean('active').notNull().default(true),
    syncedAt: at('synced_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('owner_uq').on(t.tenantId, t.system, t.externalOwnerId)],
);

export const fieldMapping = crm.table(
  'field_mapping',
  {
    id: text('id').primaryKey(), // fmp_
    tenantId: text('tenant_id').notNull(),
    system: text('system').notNull(),
    scoutField: text('scout_field').notNull(),
    crmObject: text('crm_object').notNull(), // company | contact | deal
    crmProperty: text('crm_property').notNull(),
    direction: text('direction').notNull().default('push'), // push | read
    transform: text('transform').notNull().default('none'), // none | cents_to_amount | date | enum_map
    transformConfig: jsonb('transform_config').$type<Record<string, string>>(),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [
    uniqueIndex('field_mapping_uq').on(t.tenantId, t.system, t.scoutField, t.crmObject),
    check('field_mapping_transform_valid', sql`${t.transform} in ('none', 'cents_to_amount', 'date', 'enum_map')`),
  ],
);

/** Record of the custom fields Scout created. */
export const propertySetup = crm.table(
  'property_setup',
  {
    tenantId: text('tenant_id').notNull(),
    system: text('system').notNull(),
    groupName: text('group_name').notNull(),
    createdProperties: jsonb('created_properties').$type<string[]>().notNull().default([]),
    setUpAt: at('set_up_at').notNull().defaultNow(),
    setUpBy: text('set_up_by'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.system] })],
);

/** Counts since handoff = latest minus baseline. */
export const followThrough = crm.table(
  'follow_through',
  {
    tenantId: text('tenant_id').notNull(),
    handoffId: text('handoff_id').notNull(),
    baseline: jsonb('baseline').$type<Record<string, number>>().notNull().default({}),
    latest: jsonb('latest').$type<Record<string, number>>().notNull().default({}),
    tasks: jsonb('tasks').$type<{ id: string; status: string; due: string | null }[]>().notNull().default([]),
    checkedAt: at('checked_at'),
    stage: text('stage'),
    ownerExternalId: text('owner_external_id'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.handoffId] })],
);

/** Cache of deal state. Never the source of truth. */
export const deal = crm.table(
  'deal',
  {
    id: text('id').primaryKey(), // dea_
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    system: text('system').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    stage: text('stage'),
    status: text('status').notNull(), // open | won | lost
    amountCents: bigint('amount_cents', { mode: 'number' }),
    currency: text('currency'),
    openedAt: at('opened_at'),
    closedAt: at('closed_at'),
    syncedAt: at('synced_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('deal_uq').on(t.tenantId, t.system, t.externalId),
    index('deal_account_idx').on(t.tenantId, t.accountId),
    check('deal_status_valid', sql`${t.status} in ('open', 'won', 'lost')`),
  ],
);

/** Each activity seen once. */
export const activity = crm.table(
  'activity',
  {
    id: text('id').primaryKey(), // cac_
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    handoffId: text('handoff_id'),
    system: text('system').notNull(),
    externalId: text('external_id').notNull(),
    kind: text('kind').notNull(), // email | reply | call | meeting | task_done
    occurredAt: at('occurred_at').notNull(),
  },
  (t) => [
    uniqueIndex('activity_uq').on(t.tenantId, t.system, t.externalId),
    index('activity_account_idx').on(t.tenantId, t.accountId, t.occurredAt),
    check('activity_kind_valid', sql`${t.kind} in ('email', 'reply', 'call', 'meeting', 'task_done')`),
  ],
);

/** Playbook step to CRM task. */
export const taskLink = crm.table(
  'task_link',
  {
    tenantId: text('tenant_id').notNull(),
    stepId: text('step_id').notNull(),
    system: text('system').notNull(),
    externalTaskId: text('external_task_id').notNull(),
    dueAt: at('due_at'),
    status: text('status').notNull().default('open'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.system, t.stepId] })],
);

/** What the CRM said about an account's company the last time we asked (Ruling 11). */
export const companyCheck = crm.table(
  'company_check',
  {
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    system: text('system').notNull(),
    exists: boolean('exists').notNull(),
    companyExternalId: text('company_external_id'),
    ownerExternalId: text('owner_external_id'),
    ownerName: text('owner_name'),
    lifecycle: text('lifecycle'),
    openDeals: integer('open_deals').notNull().default(0),
    checkedAt: at('checked_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.accountId, t.system] })],
);

/** One row per tenant. */
export const crmSetting = crm.table(
  'setting',
  {
    tenantId: text('tenant_id').primaryKey(),
    system: text('system').notNull().default('hubspot'),
    takeOverStaleOwnership: boolean('take_over_stale_ownership').notNull().default(true),
    pushNewPeople: boolean('push_new_people').notNull().default(true),
    followUpDays: jsonb('follow_up_days').$type<number[]>().notNull().default([3, 7, 14]),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('crm_setting_follow_up_days_valid', sql`jsonb_typeof(${t.followUpDays}) = 'array' and jsonb_array_length(${t.followUpDays}) between 1 and 5`),
  ],
);

/** Raw inbound webhook bodies, kept so a bad parse can be replayed. */
export const webhookReceipt = crm.table(
  'webhook_receipt',
  {
    id: text('id').primaryKey(), // whr_
    tenantId: text('tenant_id').notNull(),
    connectionId: text('connection_id').notNull(),
    body: text('body').notNull(),
    receivedAt: at('received_at').notNull().defaultNow(),
    processedAt: at('processed_at'),
  },
  (t) => [index('webhook_receipt_idx').on(t.tenantId, t.receivedAt)],
);

// Mock CRM state (Ruling 2). Postgres-backed so the web process and the worker see the same records.

export const mockCompany = crm.table(
  'mock_company',
  {
    tenantId: text('tenant_id').notNull(),
    externalId: text('external_id').notNull(),
    domain: text('domain').notNull(),
    name: text('name').notNull(),
    website: text('website'),
    location: text('location'),
    employees: integer('employees'),
    description: text('description'),
    ownerExternalId: text('owner_external_id'),
    lifecycle: text('lifecycle').notNull().default('lead'),
    properties: jsonb('properties').$type<Record<string, string | number | null>>().notNull().default({}),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.externalId] }), uniqueIndex('mock_company_domain_uq').on(t.tenantId, t.domain)],
);

export const mockPerson = crm.table(
  'mock_person',
  {
    tenantId: text('tenant_id').notNull(),
    externalId: text('external_id').notNull(),
    companyExternalId: text('company_external_id'),
    name: text('name').notNull(),
    title: text('title'),
    email: text('email'),
    phones: jsonb('phones').$type<string[]>().notNull().default([]),
    linkedin: text('linkedin'),
    ownerExternalId: text('owner_external_id'),
    lifecycle: text('lifecycle'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.externalId] }), index('mock_person_email_idx').on(t.tenantId, t.email)],
);

export const mockNote = crm.table(
  'mock_note',
  {
    tenantId: text('tenant_id').notNull(),
    externalId: text('external_id').notNull(),
    companyExternalId: text('company_external_id'),
    personExternalId: text('person_external_id'),
    html: text('html').notNull(),
    fingerprint: text('fingerprint').notNull(),
    ownerExternalId: text('owner_external_id'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.externalId] })],
);

export const mockTask = crm.table(
  'mock_task',
  {
    tenantId: text('tenant_id').notNull(),
    externalId: text('external_id').notNull(),
    companyExternalId: text('company_external_id'),
    personExternalId: text('person_external_id'),
    subject: text('subject').notNull(),
    body: text('body'),
    ownerExternalId: text('owner_external_id'),
    dueAt: at('due_at'),
    status: text('status').notNull().default('open'), // open | completed
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.externalId] })],
);

export const mockDeal = crm.table(
  'mock_deal',
  {
    tenantId: text('tenant_id').notNull(),
    externalId: text('external_id').notNull(),
    companyExternalId: text('company_external_id').notNull(),
    name: text('name').notNull(),
    stage: text('stage'),
    status: text('status').notNull().default('open'), // open | won | lost
    amountCents: bigint('amount_cents', { mode: 'number' }),
    currency: text('currency'),
    openedAt: at('opened_at'),
    closedAt: at('closed_at'),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.externalId] })],
);

export const mockOwner = crm.table(
  'mock_owner',
  {
    tenantId: text('tenant_id').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    email: text('email'),
    active: boolean('active').notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.externalId] })],
);

/** Activity that tests and the seed add to a mock company. */
export const mockActivity = crm.table(
  'mock_activity',
  {
    tenantId: text('tenant_id').notNull(),
    externalId: text('external_id').notNull(),
    companyExternalId: text('company_external_id').notNull(),
    kind: text('kind').notNull(),
    occurredAt: at('occurred_at').notNull(),
    actorOwnerExternalId: text('actor_owner_external_id'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.externalId] })],
);

/** Makes the mock fail an operation `remaining` more times (`setMockFailure`). */
export const mockFailure = crm.table(
  'mock_failure',
  {
    tenantId: text('tenant_id').notNull(),
    operation: text('operation').notNull(),
    kind: text('kind').notNull(), // 429 | 500 | timeout
    remaining: integer('remaining').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.operation] }), check('mock_failure_kind_valid', sql`${t.kind} in ('429', '500', 'timeout')`)],
);
