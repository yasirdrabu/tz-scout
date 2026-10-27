import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Accounts schema. Every table here is a tenant table: `tenant_id` not null, row level security
 * enabled and forced with the standard `tenant_isolation` policy (added by hand in the migration).
 * Conflicts and custom fields arrive in R2.
 */
export const accounts = pgSchema('accounts');

const textArray = (name: string) => text(name).array().notNull().default(sql`'{}'::text[]`);
const cents = (name: string) => bigint(name, { mode: 'number' });
const at = (name: string) => timestamp(name, { withTimezone: true });
const now = (name: string) => at(name).notNull().defaultNow();

export const account = accounts.table(
  'account',
  {
    id: text('id').primaryKey(), // acc_
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    matchName: text('match_name').notNull(), // matchName(name), for duplicate matching
    domain: text('domain'),
    websiteUrl: text('website_url'),
    linkedinUrl: text('linkedin_url'),
    industry: text('industry'),
    industryKey: text('industry_key'), // projected from the industry_key fact
    employees: integer('employees'),
    employeesMin: integer('employees_min'),
    employeesMax: integer('employees_max'),
    revenueCents: cents('revenue_cents'),
    revenueMinCents: cents('revenue_min_cents'),
    revenueMaxCents: cents('revenue_max_cents'),
    hqCity: text('hq_city'),
    hqState: text('hq_state'),
    hqStateKey: text('hq_state_key'), // normalised region code
    hqCountry: text('hq_country'),
    description: text('description'),
    technologies: textArray('technologies'),
    keywords: textArray('keywords'),
    parentDomain: text('parent_domain'),
    headcountGrowth6m: numeric('headcount_growth_6m', { precision: 8, scale: 4, mode: 'number' }),
    foundedYear: integer('founded_year'),
    isShell: boolean('is_shell').notNull().default(false),
    researchTier: text('research_tier'), // A | B | C
    researchTierSignalAt: at('research_tier_signal_at'),
    practiceIds: textArray('practice_ids'),
    excludedReasonKey: text('excluded_reason_key'),
    excludedOverride: boolean('excluded_override').notNull().default(false),
    crmStatus: text('crm_status').notNull().default('none'), // none | open_deal | customer
    archivedAt: at('archived_at'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [
    uniqueIndex('account_tenant_domain_uq')
      .on(t.tenantId, t.domain)
      .where(sql`archived_at is null and domain is not null`),
    index('account_tenant_match_name_idx').on(t.tenantId, t.matchName, t.hqCountry),
  ],
);

export const accountAlias = accounts.table(
  'account_alias',
  {
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind').notNull(), // domain | name | merged_id | external_id
    value: text('value').notNull(),
    system: text('system').notNull().default(''), // for external_id: hubspot, ...
    createdAt: now('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.kind, t.system, t.value] }),
    index('account_alias_lookup_idx').on(t.tenantId, t.kind, sql`lower(${t.value})`),
  ],
);

export const person = accounts.table(
  'person',
  {
    id: text('id').primaryKey(), // per_
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    firstName: text('first_name'),
    lastName: text('last_name'),
    title: text('title'),
    seniority: text('seniority'),
    email: text('email'),
    emailStatus: text('email_status'),
    phone: text('phone'),
    mobilePhone: text('mobile_phone'),
    linkedinUrl: text('linkedin_url'),
    isPrimary: boolean('is_primary').notNull().default(false),
    decisionNote: text('decision_note'),
    archivedAt: at('archived_at'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [
    uniqueIndex('person_tenant_account_email_uq')
      .on(t.tenantId, t.accountId, sql`lower(${t.email})`)
      .where(sql`archived_at is null and email is not null`),
    index('person_tenant_account_idx').on(t.tenantId, t.accountId),
  ],
);

export const personRole = accounts.table(
  'person_role',
  {
    tenantId: text('tenant_id').notNull(),
    personId: text('person_id')
      .notNull()
      .references(() => person.id),
    roleKey: text('role_key').notNull(),
    origin: text('origin').notNull(), // stated | guessed_from_title | set_by_person
    setBy: text('set_by'),
    setAt: now('set_at'),
  },
  (t) => [primaryKey({ columns: [t.personId, t.roleKey] })],
);

export const personAlias = accounts.table(
  'person_alias',
  {
    tenantId: text('tenant_id').notNull(),
    personId: text('person_id')
      .notNull()
      .references(() => person.id),
    kind: text('kind').notNull(), // email | merged_id | external_id
    value: text('value').notNull(),
    system: text('system').notNull().default(''),
    createdAt: now('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.personId, t.kind, t.system, t.value] }),
    index('person_alias_lookup_idx').on(t.tenantId, t.kind, sql`lower(${t.value})`),
  ],
);

export const fact = accounts.table(
  'fact',
  {
    id: text('id').primaryKey(), // fct_
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    personId: text('person_id').references(() => person.id),
    key: text('key').notNull(),
    value: jsonb('value'),
    valueType: text('value_type').notNull(),
    kind: text('kind').notNull(), // firmographic | contact | research | custom | form_answer
    personSourceId: text('person_source_id'),
    agentSourceId: text('agent_source_id'),
    vendorSourceId: text('vendor_source_id'),
    arrivalId: text('arrival_id'),
    url: text('url'),
    note: text('note'),
    observedAt: at('observed_at').notNull(),
    recordedAt: now('recorded_at'),
    status: text('status').notNull().default('current'), // current | candidate | superseded | archived
    pinnedBy: text('pinned_by'),
    pinnedAt: at('pinned_at'),
  },
  (t) => [index('fact_tenant_account_key_idx').on(t.tenantId, t.accountId, t.key, t.status)],
);

export const signal = accounts.table(
  'signal',
  {
    id: text('id').primaryKey(), // sig_
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    type: text('type'), // fine type, or null
    kind: text('kind').notNull(), // research | trigger | pain
    title: text('title').notNull(),
    detail: text('detail'),
    url: text('url'),
    value: jsonb('value'),
    occurredAt: at('occurred_at'), // optional only for research
    personSourceId: text('person_source_id'),
    agentSourceId: text('agent_source_id'),
    vendorSourceId: text('vendor_source_id'),
    arrivalId: text('arrival_id'),
    externalId: text('external_id'),
    recordedAt: now('recorded_at'),
    archivedAt: at('archived_at'),
  },
  (t) => [
    index('signal_tenant_account_idx').on(t.tenantId, t.accountId, t.occurredAt),
    // Duplicate check by external id; the other two duplicate keys include the day and use the index above.
    index('signal_tenant_account_external_idx')
      .on(t.tenantId, t.accountId, t.externalId)
      .where(sql`external_id is not null`),
  ],
);

export const buyingRole = accounts.table(
  'buying_role',
  {
    tenantId: text('tenant_id').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    sort: integer('sort').notNull().default(0),
    archived: boolean('archived').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

export const exclusionRule = accounts.table(
  'exclusion_rule',
  {
    tenantId: text('tenant_id').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    kind: text('kind').notNull(),
    params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

export const exclusionList = accounts.table(
  'exclusion_list',
  {
    tenantId: text('tenant_id').notNull(),
    kind: text('kind').notNull(), // vendor_keyword | parent_domain | parent_name | do_not_contact_domain
    value: text('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.kind, t.value] })],
);

export const accountSummary = accounts.table(
  'account_summary',
  {
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id')
      .primaryKey()
      .references(() => account.id),
    priority: integer('priority'),
    fit: integer('fit'),
    intent: integer('intent'),
    tier: text('tier'),
    bestOfferId: text('best_offer_id'),
    practiceId: text('practice_id'),
    practiceIds: textArray('practice_ids'),
    reviewStatusKey: text('review_status_key'),
    ownerUserId: text('owner_user_id'),
    stage: text('stage'),
    sourceIds: textArray('source_ids'),
    lastSignalAt: at('last_signal_at'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [
    index('account_summary_source_ids_idx').using('gin', t.sourceIds),
    index('account_summary_practice_ids_idx').using('gin', t.practiceIds),
    index('account_summary_priority_idx').on(t.tenantId, t.priority.desc().nullsLast(), t.createdAt),
  ],
);
