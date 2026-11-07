import { sql } from 'drizzle-orm';
import { bigint, check, date, index, integer, pgSchema, primaryKey, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Analytics schema. Every table here is a tenant table: `tenant_id` not null, row level security
 * enabled and forced with the standard `tenant_isolation` policy (added by hand in the migration).
 */
export const analytics = pgSchema('analytics');

const at = (name: string) => timestamp(name, { withTimezone: true });

/**
 * The cost ledger (R3a Ruling 5). Lines are never updated in place, except to void them: an edit voids
 * the old line ("Edited") and adds a new one with `replaces_id`.
 */
export const costLine = analytics.table(
  'cost_line',
  {
    id: text('id').primaryKey(), // cst_
    tenantId: text('tenant_id').notNull(),
    /** The tenant-timezone date the cost belongs to. */
    occurredOn: date('occurred_on').notNull(),
    category: text('category').notNull(), // partner_fees | data_vendors | agents_hosting | lists_events | ai_usage
    /** The paid provider, for usage lines. */
    provider: text('provider'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    origin: text('origin').notNull(), // usage | manual
    /** The `integrations.usage.recorded` event a usage line came from: one line per event. */
    originEventId: text('origin_event_id'),
    accountId: text('account_id'),
    /** R3b-1 Ruling 7: the source the cost is for; it wins over the account's first source (Ruling 6). */
    sourceId: text('source_id'),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: at('created_at').notNull().defaultNow(),
    voidedAt: at('voided_at'),
    voidReason: text('void_reason'),
    voidedBy: text('voided_by'),
    /** The line an edit voided to make this one. */
    replacesId: text('replaces_id'),
  },
  (t) => [
    uniqueIndex('cost_line_origin_event_unique').on(t.originEventId),
    index('cost_line_tenant_occurred_idx').on(t.tenantId, t.occurredOn, t.createdAt),
    check('cost_line_origin_valid', sql`${t.origin} in ('usage', 'manual')`),
    check(
      'cost_line_category_valid',
      sql`${t.category} in ('partner_fees', 'data_vendors', 'agents_hosting', 'lists_events', 'ai_usage')`,
    ),
    check('cost_line_amount_valid', sql`${t.amountCents} >= 0`),
  ],
);

/**
 * Monthly budgets per category (R3a Ruling 7). A month with no row of its own carries the latest earlier
 * month's row forward. None, or 0, means no alert and no pause.
 */
export const costBudget = analytics.table(
  'cost_budget',
  {
    tenantId: text('tenant_id').notNull(),
    category: text('category').notNull(),
    month: text('month').notNull(), // YYYY-MM, the tenant-timezone calendar month
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.category, t.month] }),
    check('cost_budget_amount_valid', sql`${t.amountCents} >= 0`),
  ],
);

/**
 * The last budget level per category and month (Ruling 8). A change publishes
 * `analytics.budget.level_changed`; the row is locked while a level is worked out.
 */
export const budgetState = analytics.table(
  'budget_state',
  {
    tenantId: text('tenant_id').notNull(),
    category: text('category').notNull(),
    month: text('month').notNull(),
    level: text('level').notNull(), // ok | alert | over | paused
    /** Counts level changes, so a consumer can drop an older `level_changed` delivered late. */
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.category, t.month] }),
    check('budget_state_level_valid', sql`${t.level} in ('ok', 'alert', 'over', 'paused')`),
  ],
);

/** Workspace cost settings (R3b-1 Ruling 8): the target cost per won account, none by default. */
export const costSetting = analytics.table('cost_setting', {
  tenantId: text('tenant_id').primaryKey(),
  targetCostPerWonCents: bigint('target_cost_per_won_cents', { mode: 'number' }),
  updatedBy: text('updated_by'),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

/**
 * One row per account (R3b-1 Ruling 1): its first arrival (the chain's closest source and the batch) and the
 * practice and offer scoring picked. A score or a stage move can arrive before the arrival, so the row can exist
 * with no arrival yet (`first_source_id` and `arrived_at` null); reads skip it until the arrival fills them.
 * `exit_at` is the time of the latest stage move the row has seen to an exit or a flow stage, and `exit_stage`
 * is set only when that move was to an exit, so an older move delivered late changes neither.
 */
export const journey = analytics.table('journey', {
  tenantId: text('tenant_id').notNull(),
  accountId: text('account_id').primaryKey(),
  firstSourceId: text('first_source_id'),
  firstBatchId: text('first_batch_id'),
  arrivedAt: at('arrived_at'),
  practiceId: text('practice_id'),
  offerId: text('offer_id'),
  /** The `version` of the score that set practice and offer: an older score delivered late is ignored. */
  scoreVersion: integer('score_version'),
  exitStage: text('exit_stage'),
  exitAt: at('exit_at'),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

/** The earliest time an account entered each stage: a late or retried event never moves it. */
export const journeyStage = analytics.table(
  'journey_stage',
  {
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    stageKey: text('stage_key').notNull(),
    enteredAt: at('entered_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.accountId, t.stageKey] })],
);

/** Each CRM deal's latest state; a row only takes an event with a later `observed_at`. */
export const journeyDeal = analytics.table(
  'journey_deal',
  {
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    system: text('system').notNull(),
    dealExternalId: text('deal_external_id').notNull(),
    status: text('status').notNull(), // open | won | lost
    amountCents: bigint('amount_cents', { mode: 'number' }),
    closedAt: at('closed_at'),
    observedAt: at('observed_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.system, t.dealExternalId] }),
    index('journey_deal_account_idx').on(t.tenantId, t.accountId),
    check('journey_deal_status_valid', sql`${t.status} in ('open', 'won', 'lost')`),
  ],
);

/**
 * One row per credited step per outcome (R3c-2 Ruling 8), filled from `playbooks.outcome.recorded`. An outcome with
 * no credited step has one row with `step_id` and `step_type` null ("No recent step"). The unique index treats nulls
 * as equal, so a replayed event adds nothing. `practice_id` and `offer_id` come from the account's journey when the
 * event arrives; `account_id` is kept for the data limit and for merges.
 */
export const stepCredit = analytics.table(
  'step_credit',
  {
    tenantId: text('tenant_id').notNull(),
    outcomeId: text('outcome_id').notNull(),
    outcomeKind: text('outcome_kind').notNull(),
    stepId: text('step_id'),
    stepType: text('step_type'),
    playbookTemplateId: text('playbook_template_id'),
    practiceId: text('practice_id'),
    offerId: text('offer_id'),
    accountId: text('account_id').notNull(),
    occurredAt: at('occurred_at').notNull(),
  },
  (t) => [
    unique('step_credit_outcome_step_uq').on(t.tenantId, t.outcomeId, t.stepId).nullsNotDistinct(),
    index('step_credit_tenant_occurred_idx').on(t.tenantId, t.occurredAt),
    index('step_credit_account_idx').on(t.tenantId, t.accountId),
    check('step_credit_kind_valid', sql`${t.outcomeKind} in ('reply', 'meeting', 'opportunity', 'won', 'lost', 'no_response')`),
    check('step_credit_type_valid', sql`${t.stepType} is null or ${t.stepType} in ('email', 'linkedin', 'call', 'meeting', 'task')`),
  ],
);
