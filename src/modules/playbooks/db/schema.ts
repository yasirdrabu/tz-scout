import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Playbooks schema. Every table here is a tenant table: `tenant_id` not null, row level security
 * enabled and forced with the standard `tenant_isolation` policy (added by hand in the migration).
 */
export const playbooks = pgSchema('playbooks');

const at = (name: string) => timestamp(name, { withTimezone: true });

/** One brief per account: Scout's recommendation, the opener, who to approach first, and the drafting state (Rulings 1 to 3). */
export const brief = playbooks.table(
  'brief',
  {
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    /** The lead offer the brief was written for. */
    offerId: text('offer_id'),
    mode: text('mode'), // live | mock | rules
    aiRunId: text('ai_run_id'),
    recommendationHeadline: text('recommendation_headline'),
    recommendationDetail: text('recommendation_detail'),
    recommendationOrigin: text('recommendation_origin'), // ai | rules
    openerSubject: text('opener_subject'),
    openerBody: text('opener_body'),
    openerOrigin: text('opener_origin'), // ai | rules
    whoFirstPersonId: text('who_first_person_id'),
    whoFirstTitle: text('who_first_title'),
    whoFirstReason: text('who_first_reason'),
    draftState: text('draft_state').notNull().default('not_drafted'), // not_drafted | drafting | ready
    requestedSeq: integer('requested_seq').notNull().default(0),
    draftedSeq: integer('drafted_seq').notNull().default(0),
    /** Set while the account has an open or accepted assignment: automatic redrafts stop. */
    frozenAt: at('frozen_at'),
    /** The open assignment that froze it; only that assignment's decline or withdrawal unfreezes it. */
    frozenByAssignmentId: text('frozen_by_assignment_id'),
    /** The latest request number that came from a person (manual: Claude at any tier, fresh). */
    manualSeq: integer('manual_seq').notNull().default(0),
    /** Edited sections a person asked a draft to overwrite, until a draft takes them. */
    pendingIncludeEdited: text('pending_include_edited').array().notNull().default(sql`'{}'::text[]`),
    /** Runs of the current draft job, counted in their own transaction so a run that times out still counts. */
    draftJobId: text('draft_job_id'),
    draftAttempts: integer('draft_attempts').notNull().default(0),
    lastError: text('last_error'),
    draftedAt: at('drafted_at'),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.accountId] }),
    check('brief_draft_state_valid', sql`${t.draftState} in ('not_drafted', 'drafting', 'ready')`),
    check('brief_mode_valid', sql`${t.mode} is null or ${t.mode} in ('live', 'mock', 'rules')`),
  ],
);

const sectionColumns = () => ({
  tenantId: text('tenant_id').notNull(),
  accountId: text('account_id').notNull(),
  key: text('key').notNull(),
  body: text('body').notNull(),
  /** `fct_`, `sig_` and `per_` ids the text rests on. */
  citations: text('citations').array().notNull().default(sql`'{}'::text[]`),
  origin: text('origin').notNull(), // ai | rules | human
  mode: text('mode'), // live | mock | rules; null for human
  aiRunId: text('ai_run_id'),
  offerId: text('offer_id'),
  /** A user id, or `key:<id>` for an API key. */
  editedBy: text('edited_by'),
  editedByName: text('edited_by_name'),
  editedAt: at('edited_at'),
  version: integer('version').notNull().default(1),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

/** One row per (account, key). A section a person wrote is never overwritten by a draft unless asked (Ruling 4). */
export const briefSection = playbooks.table('brief_section', sectionColumns(), (t) => [
  primaryKey({ columns: [t.tenantId, t.accountId, t.key] }),
  check('brief_section_origin_valid', sql`${t.origin} in ('ai', 'rules', 'human')`),
]);

/** Append only: the version a write replaced. */
export const briefSectionHistory = playbooks.table(
  'brief_section_history',
  { ...sectionColumns(), recordedAt: at('recorded_at').notNull().defaultNow() },
  (t) => [primaryKey({ columns: [t.tenantId, t.accountId, t.key, t.version] })],
);

/** A reusable playbook: a day-by-day list of steps (Ruling 6). Saving an active template with step changes bumps `version`. */
export const playbookTemplate = playbooks.table(
  'playbook_template',
  {
    id: text('id').primaryKey(), // plb_
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    whenToUse: text('when_to_use'),
    status: text('status').notNull().default('draft'), // draft | active | archived
    /** Stored, not acted on until R2c-3: reply_or_meeting | meeting | never. */
    stopWhen: text('stop_when').notNull().default('reply_or_meeting'),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by'),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedBy: text('updated_by'),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('playbook_template_tenant_idx').on(t.tenantId),
    check('playbook_template_status_valid', sql`${t.status} in ('draft', 'active', 'archived')`),
    check('playbook_template_stop_when_valid', sql`${t.stopWhen} in ('reply_or_meeting', 'meeting', 'never')`),
  ],
);

/** One step of a template at a given template version (Ruling 7). Old versions stay readable. */
export const templateStep = playbooks.table(
  'template_step',
  {
    id: text('id').primaryKey(), // pls_
    tenantId: text('tenant_id').notNull(),
    templateId: text('template_id')
      .notNull()
      .references(() => playbookTemplate.id),
    templateVersion: integer('template_version').notNull(),
    order: integer('order').notNull(),
    /** Calendar days after the start date; 0 is the start day. */
    day: integer('day').notNull(),
    channel: text('channel').notNull(), // email | linkedin | call | meeting | task
    ownerRole: text('owner_role').notNull(), // seller | leader | operator
    title: text('title').notNull(),
    detail: text('detail'),
    targetBuyingRoles: text('target_buying_roles').array().notNull().default(sql`'{}'::text[]`),
    crmTask: boolean('crm_task').notNull().default(true),
    /** Email steps only; raw text with placeholders. */
    subject: text('subject'),
    body: text('body'),
  },
  (t) => [
    uniqueIndex('template_step_order_uq').on(t.templateId, t.templateVersion, t.order),
    check('template_step_day_valid', sql`${t.day} between 0 and 365`),
    check('template_step_channel_valid', sql`${t.channel} in ('email', 'linkedin', 'call', 'meeting', 'task')`),
    check('template_step_owner_role_valid', sql`${t.ownerRole} in ('seller', 'leader', 'operator')`),
  ],
);

/** The playbook an offer starts for accounts of a tier (Ruling 3). Only act_now, good_fit and watch can be mapped. */
export const offerPlaybook = playbooks.table(
  'offer_playbook',
  {
    tenantId: text('tenant_id').notNull(),
    offerId: text('offer_id').notNull(),
    tier: text('tier').notNull(), // act_now | good_fit | watch
    templateId: text('template_id')
      .notNull()
      .references(() => playbookTemplate.id),
    updatedBy: text('updated_by'),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.offerId, t.tier] }),
    check('offer_playbook_tier_valid', sql`${t.tier} in ('act_now', 'good_fit', 'watch')`),
  ],
);

/** A running playbook on an account, started when an assignment is accepted (Rulings 2, 9, 10). Snapshots the template version. */
export const accountPlan = playbooks.table(
  'account_plan',
  {
    id: text('id').primaryKey(), // pln_
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    /** Null when the assigner picked a playbook for an account with no lead offer or no mappable tier. */
    offerId: text('offer_id'),
    tier: text('tier'),
    templateId: text('template_id')
      .notNull()
      .references(() => playbookTemplate.id),
    templateVersion: integer('template_version').notNull(),
    /** The accepted assignment that started it; unique, so a redelivered event makes one plan. */
    assignmentId: text('assignment_id').notNull(),
    sellerUserId: text('seller_user_id'),
    status: text('status').notNull().default('active'), // active | paused | completed | stopped | abandoned
    stopWhen: text('stop_when').notNull(),
    /** The accept day in the tenant timezone. */
    startDate: date('start_date', { mode: 'string' }).notNull(),
    statusReason: text('status_reason'),
    /** When the accepted event that started, resumed or last took over the plan happened; an older accept never takes it back. Plans that existed before this column read their migration time. */
    acceptedAt: at('accepted_at').notNull().defaultNow(),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('account_plan_open_uq')
      .on(t.tenantId, t.accountId)
      .where(sql`status in ('active', 'paused')`),
    uniqueIndex('account_plan_assignment_uq').on(t.tenantId, t.assignmentId),
    index('account_plan_account_idx').on(t.tenantId, t.accountId),
    check('account_plan_status_valid', sql`${t.status} in ('active', 'paused', 'completed', 'stopped', 'abandoned')`),
    check('account_plan_tier_valid', sql`${t.tier} in ('act_now', 'good_fit', 'watch')`),
    check('account_plan_stop_when_valid', sql`${t.stopWhen} in ('reply_or_meeting', 'meeting', 'never')`),
  ],
);

/** A rendered step of a plan. The text is fixed when the plan is built. */
export const planStep = playbooks.table(
  'plan_step',
  {
    id: text('id').primaryKey(), // stp_
    tenantId: text('tenant_id').notNull(),
    planId: text('plan_id')
      .notNull()
      .references(() => accountPlan.id),
    /** The template step it came from; null for steps added to the plan by hand. */
    templateStepId: text('template_step_id'),
    order: integer('order').notNull(),
    day: integer('day').notNull(),
    channel: text('channel').notNull(),
    ownerRole: text('owner_role').notNull(),
    ownerUserId: text('owner_user_id'),
    title: text('title').notNull(),
    detail: text('detail'),
    targetPersonIds: text('target_person_ids').array().notNull().default(sql`'{}'::text[]`),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    status: text('status').notNull().default('todo'), // todo | in_progress | done | skipped
    doneAt: at('done_at'),
    doneBy: text('done_by'),
    note: text('note'),
    origin: text('origin').notNull().default('template'), // template | added | edited
    crmTask: boolean('crm_task').notNull().default(true),
    subject: text('subject'),
    body: text('body'),
  },
  (t) => [
    index('plan_step_plan_idx').on(t.planId, t.order),
    index('plan_step_owner_idx').on(t.tenantId, t.ownerUserId, t.status),
    check('plan_step_status_valid', sql`${t.status} in ('todo', 'in_progress', 'done', 'skipped')`),
    check('plan_step_origin_valid', sql`${t.origin} in ('template', 'added', 'edited')`),
    check('plan_step_channel_valid', sql`${t.channel} in ('email', 'linkedin', 'call', 'meeting', 'task')`),
    check('plan_step_owner_role_valid', sql`${t.ownerRole} in ('seller', 'leader', 'operator')`),
  ],
);

/** Append only: who changed a plan or step, when, and what (Ruling 11). */
export const planChange = playbooks.table(
  'plan_change',
  {
    id: text('id').primaryKey(), // pch_
    tenantId: text('tenant_id').notNull(),
    planId: text('plan_id')
      .notNull()
      .references(() => accountPlan.id),
    stepId: text('step_id'),
    kind: text('kind').notNull(), // e.g. status | step_status | owner | due_date | note
    detail: jsonb('detail'),
    by: text('by'),
    at: at('at').notNull().defaultNow(),
  },
  (t) => [index('plan_change_plan_idx').on(t.planId, t.at)],
);
