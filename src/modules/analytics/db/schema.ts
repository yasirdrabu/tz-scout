import { sql } from 'drizzle-orm';
import { bigint, check, date, index, pgSchema, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

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
