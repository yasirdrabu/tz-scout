import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { ReviewFlags } from '../contracts/types';

/**
 * Routing schema (review and routing). Every table here is a tenant table: `tenant_id` not null, row
 * level security enabled and forced with the standard `tenant_isolation` policy (added by hand in the migration).
 */
export const routing = pgSchema('routing');

const at = (name: string) => timestamp(name, { withTimezone: true });

/** The tenant's review statuses. Archived ones keep their history. */
export const reviewStatusDef = routing.table(
  'review_status_def',
  {
    id: text('id').primaryKey(), // rsd_
    tenantId: text('tenant_id').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    order: integer('order').notNull(),
    countsAsReviewed: boolean('counts_as_reviewed').notNull().default(false),
    isDeclined: boolean('is_declined').notNull().default(false),
    isInitial: boolean('is_initial').notNull().default(false),
    returnsToSource: boolean('returns_to_source').notNull().default(false),
    tone: text('tone').notNull().default('neutral'), // neutral | near | good | bad
    archivedAt: at('archived_at'),
  },
  (t) => [uniqueIndex('review_status_def_key_uq').on(t.tenantId, t.key)],
);

/** Starting status per source kind, overridden per source. */
export const initialStatusRule = routing.table(
  'initial_status_rule',
  {
    tenantId: text('tenant_id').notNull(),
    sourceKind: text('source_kind').notNull(), // agent | vendor | person | import | crm | form
    sourceId: text('source_id'),
    statusKey: text('status_key').notNull(),
  },
  (t) => [uniqueIndex('initial_status_rule_uq').on(t.tenantId, t.sourceKind, sql`coalesce(${t.sourceId}, '')`)],
);

export const declineReasonDef = routing.table(
  'decline_reason_def',
  {
    id: text('id').primaryKey(), // drd_
    tenantId: text('tenant_id').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    appliesTo: text('applies_to').notNull(), // review | assignment | both
    archivedAt: at('archived_at'),
  },
  (t) => [uniqueIndex('decline_reason_def_key_uq').on(t.tenantId, t.key)],
);

/** One row per account. Every write bumps `version` and publishes `routing.review.changed`. */
export const accountReview = routing.table(
  'account_review',
  {
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    statusKey: text('status_key').notNull(),
    statusChangedAt: at('status_changed_at').notNull().defaultNow(),
    statusChangedBy: text('status_changed_by'),
    leadOfferOverrideId: text('lead_offer_override_id'),
    insights: text('insights'),
    insightsBy: text('insights_by'),
    insightsAt: at('insights_at'),
    currentAssignmentId: text('current_assignment_id'),
    stage: text('stage').notNull().default('arrived'),
    stageChangedAt: at('stage_changed_at').notNull().defaultNow(),
    flags: jsonb('flags').$type<ReviewFlags>().notNull().default({}), // newFrom, declinedBySeller, handoff
    version: integer('version').notNull().default(1),
    /** Set when the account was merged into another; the row is then kept read-only, as a record. */
    mergedInto: text('merged_into'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.accountId] })],
);

export const statusChange = routing.table(
  'status_change',
  {
    id: text('id').primaryKey(), // rsc_
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    fromKey: text('from_key'),
    toKey: text('to_key').notNull(),
    note: text('note'),
    reasonKey: text('reason_key'),
    by: text('by').notNull(),
    at: at('at').notNull().defaultNow(),
  },
  (t) => [index('status_change_account_at_idx').on(t.tenantId, t.accountId, sql`${t.at} desc`)],
);

export const assignment = routing.table(
  'assignment',
  {
    id: text('id').primaryKey(), // asg_
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    sellerUserId: text('seller_user_id').notNull(),
    assignedBy: text('assigned_by').notNull(),
    assignedAt: at('assigned_at').notNull().defaultNow(),
    notes: text('notes'),
    templateId: text('template_id'),
    status: text('status').notNull().default('pending'), // pending | accepted | declined | withdrawn | replaced
    respondedAt: at('responded_at'),
    acceptedHow: text('accepted_how'), // seller | crm_activity | auto_timeout
    declineReasonKey: text('decline_reason_key'),
    declineNote: text('decline_note'),
    previousAssignmentId: text('previous_assignment_id'),
    ownershipDecision: text('ownership_decision').notNull().default('assign'), // assign | keep (REV-E3-S1-AC2)
  },
  (t) => [
    // At most one open assignment per account.
    uniqueIndex('assignment_open_uq')
      .on(t.tenantId, t.accountId)
      .where(sql`${t.status} in ('pending', 'accepted')`),
    index('assignment_account_idx').on(t.tenantId, t.accountId, t.assignedAt),
    index('assignment_seller_idx').on(t.tenantId, t.sellerUserId),
  ],
);

/** A stage move. The unique index on the cause makes a redelivered event a no-op, even when two deliveries race. */
export const stageChange = routing.table(
  'stage_change',
  {
    id: text('id').primaryKey(), // stc_
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    fromStage: text('from_stage').notNull(),
    toStage: text('to_stage').notNull(),
    causeEventId: text('cause_event_id').notNull(),
    at: at('at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('stage_change_cause_uq').on(t.tenantId, t.accountId, t.causeEventId),
    index('stage_change_account_at_idx').on(t.tenantId, t.accountId, sql`${t.at} desc`),
  ],
);

/** One row per tenant. `auto_accept_working_days` is 1 to 10, or null for off. */
export const routingSetting = routing.table(
  'routing_setting',
  {
    tenantId: text('tenant_id').primaryKey(),
    autoAcceptWorkingDays: integer('auto_accept_working_days').default(2),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [check('routing_setting_auto_accept_range', sql`${t.autoAcceptWorkingDays} is null or ${t.autoAcceptWorkingDays} between 1 and 10`)],
);
