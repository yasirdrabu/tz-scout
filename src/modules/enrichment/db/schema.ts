import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Enrichment schema. Every table here is a tenant table: `tenant_id` not null, row level security
 * enabled and forced with the standard `tenant_isolation` policy (added by hand in the migration).
 */
export const enrichment = pgSchema('enrichment');

const at = (name: string) => timestamp(name, { withTimezone: true });

/** One enrichment: what to find for an account, its approval, and how the run went (Rulings 1, 7 to 9). */
export const request = enrichment.table(
  'request',
  {
    id: text('id').primaryKey(), // enr_
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id'),
    kind: text('kind').notNull(), // company_firmographics | people_for_roles | email_reveal | website_read | signals_refresh
    params: jsonb('params').notNull().default({}), // { roles?, person_ids? }
    providerKey: text('provider_key').notNull(),
    connectionId: text('connection_id'),
    /** Set at run: whether the provider answered with sample data. */
    connectionMode: text('connection_mode'), // mock | live
    /** The principal: a user id, or `key:<id>` for an API key. */
    requestedBy: text('requested_by').notNull(),
    requestedByLabel: text('requested_by_label'), // "Dana Ruiz", "Yasir's agent"
    requestingSourceId: text('requesting_source_id'),
    reason: text('reason'),
    /** Principals who asked for the same thing while this was open (Ruling 6). */
    watchers: text('watchers').array().notNull().default(sql`'{}'::text[]`),
    estimate: jsonb('estimate').notNull(), // { credits, cost_cents, ai_tokens? }
    status: text('status').notNull(),
    /** Set while an approved request waits on a usage limit; cleared when it runs. */
    waitingReason: text('waiting_reason'),
    decidedBy: text('decided_by'),
    decidedByLabel: text('decided_by_label'),
    decidedAt: at('decided_at'),
    /** A decline's reason, or `expired`. */
    declineReason: text('decline_reason'),
    startedAt: at('started_at'),
    finishedAt: at('finished_at'),
    result: jsonb('result'), // { arrival_ids, credits_used, cost_cents, found, message? }
    error: jsonb('error'), // { kind, message }
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('request_tenant_status_created_idx').on(t.tenantId, t.status, t.createdAt),
    index('request_tenant_account_idx').on(t.tenantId, t.accountId),
    check(
      'request_status_valid',
      sql`${t.status} in ('flagged', 'approved', 'declined', 'cancelled', 'running', 'completed', 'partial', 'failed')`,
    ),
    check(
      'request_kind_valid',
      sql`${t.kind} in ('company_firmographics', 'people_for_roles', 'email_reveal', 'website_read', 'signals_refresh')`,
    ),
    check('request_connection_mode_valid', sql`${t.connectionMode} is null or ${t.connectionMode} in ('mock', 'live')`),
  ],
);
