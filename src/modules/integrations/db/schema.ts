import { index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Integrations schema. Every table here is a tenant table: `tenant_id` not null, row level security
 * enabled and forced with the standard `tenant_isolation` policy (added by hand in the migration).
 * Usage caps tables arrive in R1.
 */
export const integrations = pgSchema('integrations');

export const connection = integrations.table(
  'connection',
  {
    id: text('id').primaryKey(), // con_
    tenantId: text('tenant_id').notNull(),
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    mode: text('mode').notNull().default('mock'), // mock | live
    status: text('status').notNull().default('not_set_up'), // not_set_up | connected | failing | disabled
    settings: jsonb('settings').notNull().default({}),
    credentialId: text('credential_id'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestResult: jsonb('last_test_result'), // { ok, message, missingPermissions? }
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('connection_tenant_provider_name_uq').on(t.tenantId, t.provider, t.name)],
);

export const credential = integrations.table(
  'credential',
  {
    id: text('id').primaryKey(), // cred_
    tenantId: text('tenant_id').notNull(),
    connectionId: text('connection_id').notNull(),
    kind: text('kind').notNull(), // api_key | private_app_token | oauth_tokens | client_secret
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    wrappedDataKey: text('wrapped_data_key').notNull(),
    keyVersion: integer('key_version').notNull(),
    hint: text('hint').notNull(), // last 4 characters
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    /** Set when a newer credential replaced this one; the cleanup job deletes it an hour later. */
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('credential_connection_idx').on(t.tenantId, t.connectionId)],
);

export const callLog = integrations.table(
  'call_log',
  {
    id: text('id').primaryKey(), // call_
    tenantId: text('tenant_id').notNull(),
    connectionId: text('connection_id'),
    provider: text('provider').notNull(),
    operation: text('operation').notNull(),
    module: text('module'),
    principalId: text('principal_id'),
    apiKeyId: text('api_key_id'),
    correlationId: text('correlation_id'),
    requestSummary: jsonb('request_summary'),
    statusCode: integer('status_code'),
    outcome: text('outcome').notNull(), // ok | error | rate_limited | blocked_by_cap
    durationMs: integer('duration_ms').notNull(),
    units: integer('units'),
    unit: text('unit'),
    costCents: integer('cost_cents'),
    errorMessage: text('error_message'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('call_log_tenant_at_idx').on(t.tenantId, t.at),
    index('call_log_tenant_provider_at_idx').on(t.tenantId, t.provider, t.at),
  ],
);
