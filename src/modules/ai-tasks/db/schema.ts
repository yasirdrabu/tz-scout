import { boolean, index, integer, jsonb, pgSchema, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * AI schema. Both tables are tenant tables: `tenant_id` not null, row level security enabled and
 * forced with the standard `tenant_isolation` policy (added by hand in the migration).
 */
export const ai = pgSchema('ai');

export const aiRun = ai.table(
  'ai_run',
  {
    id: text('id').primaryKey(), // run_
    tenantId: text('tenant_id').notNull(),
    task: text('task').notNull(),
    promptVersion: text('prompt_version').notNull(),
    mode: text('mode').notNull(), // live | rules | mock
    model: text('model'), // null for rules runs
    inputHash: text('input_hash').notNull(),
    inputRef: jsonb('input_ref'), // { subject: { type, id } }
    status: text('status').notNull(), // ok | invalid_output | error | refused_by_cap
    output: jsonb('output'),
    error: text('error'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    costCents: integer('cost_cents').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    actor: text('actor').notNull(), // "<kind>:<id>"
    correlationId: text('correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_run_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('ai_run_reuse_idx').on(t.tenantId, t.task, t.promptVersion, t.inputHash),
  ],
);

export const aiSetting = ai.table(
  'ai_setting',
  {
    tenantId: text('tenant_id').notNull(),
    task: text('task').notNull(),
    model: text('model'), // override
    enabled: boolean('enabled').notNull().default(true),
    maxCostCentsPerRun: integer('max_cost_cents_per_run'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.task] })],
);
