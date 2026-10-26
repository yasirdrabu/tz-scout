import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Tenancy schema.
 *
 * Platform-wide tables, EXEMPT from row level security (no tenant policy; people and tenants span
 * tenants): `tenant` (written through `adminDb`) and `user`. Better-auth tables (session, account,
 * verification) join them in Task 11 and are exempt too.
 *
 * Tenant tables (`membership`, `invite`, `api_key`) carry `tenant_id` and have row level security
 * enabled and forced with the standard `tenant_isolation` policy (added by hand in the migration).
 */
export const tenancy = pgSchema('tenancy');

export const tenant = tenancy.table('tenant', {
  id: text('id').primaryKey(), // t_
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  currency: text('currency').notNull(), // ISO 4217
  timezone: text('timezone').notNull(),
  status: text('status').notNull().default('active'), // active | suspended
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One person, identified by email. Column names `name`, `email`, `email_verified`, `image` follow better-auth. */
export const user = tenancy.table('user', {
  id: text('id').primaryKey(), // usr_
  name: text('name').notNull(),
  email: text('email').notNull().unique(), // lower case
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  platformAdmin: boolean('platform_admin').notNull().default(false),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  lastTenantId: text('last_tenant_id'),
  lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
  entraObjectId: text('entra_object_id'),
});

export const membership = tenancy.table(
  'membership',
  {
    id: text('id').primaryKey(), // mbr_
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').notNull(), // owner | leader | seller | operator
    extraPermissions: text('extra_permissions').array().notNull().default(sql`'{}'::text[]`),
    dataLimit: jsonb('data_limit'),
    crmOwnerIds: jsonb('crm_owner_ids').notNull().default(sql`'{}'::jsonb`), // { hubspot: "123" }
    invitedBy: text('invited_by'),
    status: text('status').notNull(), // invited | active | removed
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('membership_tenant_user_uq').on(t.tenantId, t.userId), index('membership_user_idx').on(t.userId)],
);

export const invite = tenancy.table(
  'invite',
  {
    id: text('id').primaryKey(), // inv_
    tenantId: text('tenant_id').notNull(),
    email: text('email').notNull(),
    role: text('role').notNull(),
    kind: text('kind').notNull(), // member | partner
    tokenHash: text('token_hash').notNull(),
    invitedBy: text('invited_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('invite_tenant_email_idx').on(t.tenantId, t.email)],
);

export const apiKey = tenancy.table(
  'api_key',
  {
    id: text('id').primaryKey(), // key_
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(), // first 12 characters, shown
    secretHash: text('secret_hash').notNull(), // argon2id
    environment: text('environment').notNull(), // live | test
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    dataLimit: jsonb('data_limit'),
    sourceId: text('source_id'),
    rateLimitPerMinute: integer('rate_limit_per_minute'),
    dailyArrivalCap: integer('daily_arrival_cap'),
    monthlyEnrichmentCreditCap: integer('monthly_enrichment_credit_cap'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('api_key_prefix_idx').on(t.prefix), index('api_key_tenant_idx').on(t.tenantId)],
);
