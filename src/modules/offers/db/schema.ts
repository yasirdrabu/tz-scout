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
 * Offers schema. Every table here is a tenant table: `tenant_id` not null, row level security
 * enabled and forced with the standard `tenant_isolation` policy (added by hand in the migration).
 * Readiness, segments and won deals arrive in later releases.
 */
export const offers = pgSchema('offers');

const textArray = (name: string) => text(name).array().notNull().default(sql`'{}'::text[]`);
const cents = (name: string) => bigint(name, { mode: 'number' });

export const practice = offers.table(
  'practice',
  {
    id: text('id').primaryKey(), // prc_
    tenantId: text('tenant_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    keywords: textArray('keywords'), // used to file imported sheets
    status: text('status').notNull().default('active'), // active | archived
    defaultPlaybookId: text('default_playbook_id'),
    briefTemplateKey: text('brief_template_key'),
    sort: integer('sort').notNull().default(0), // tie-break when two practices match a hint
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('practice_tenant_slug_uq').on(t.tenantId, t.slug)],
);

export const offer = offers.table(
  'offer',
  {
    id: text('id').primaryKey(), // off_
    tenantId: text('tenant_id').notNull(),
    practiceId: text('practice_id')
      .notNull()
      .references(() => practice.id),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    promise: text('promise').notNull(),
    description: text('description'),
    status: text('status').notNull().default('draft'), // draft | approved | archived
    priceMinCents: cents('price_min_cents'),
    priceMaxCents: cents('price_max_cents'),
    grossMargin: numeric('gross_margin', { precision: 6, scale: 4, mode: 'number' }),
    typicalDealCents: cents('typical_deal_cents'),
    expansionRate: numeric('expansion_rate', { precision: 6, scale: 4, mode: 'number' }),
    expansionValueCents: cents('expansion_value_cents'),
    salesCycleDays: integer('sales_cycle_days'),
    targetTitles: textArray('target_titles'),
    targetBuyingRoles: textArray('target_buying_roles'),
    companySizeMin: integer('company_size_min'),
    companySizeMax: integer('company_size_max'),
    revenueMinCents: cents('revenue_min_cents'),
    revenueMaxCents: cents('revenue_max_cents'),
    industries: textArray('industries'),
    regions: textArray('regions'),
    excludedDomains: textArray('excluded_domains'),
    excludedCategories: textArray('excluded_categories'),
    proofPoints: textArray('proof_points'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    origin: text('origin').notNull().default('manual'), // manual | ai_draft
    draftSource: jsonb('draft_source'), // { url or fileName, aiRunId }
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('offer_tenant_slug_uq').on(t.tenantId, t.slug),
    index('offer_tenant_practice_idx').on(t.tenantId, t.practiceId),
  ],
);

export const caseStudy = offers.table(
  'case_study',
  {
    id: text('id').primaryKey(), // cs_
    tenantId: text('tenant_id').notNull(),
    title: text('title').notNull(),
    clientName: text('client_name'),
    industry: text('industry'),
    result: text('result'),
    linkUrl: text('link_url'),
    public: boolean('public').notNull().default(false), // may be quoted to buyers
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('case_study_tenant_idx').on(t.tenantId)],
);

export const offerCaseStudy = offers.table(
  'offer_case_study',
  {
    tenantId: text('tenant_id').notNull(),
    offerId: text('offer_id')
      .notNull()
      .references(() => offer.id),
    caseStudyId: text('case_study_id')
      .notNull()
      .references(() => caseStudy.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.offerId, t.caseStudyId] }),
    index('offer_case_study_case_idx').on(t.tenantId, t.caseStudyId),
  ],
);

export const signalRule = offers.table(
  'signal_rule',
  {
    id: text('id').primaryKey(), // sr_
    tenantId: text('tenant_id').notNull(),
    offerId: text('offer_id')
      .notNull()
      .references(() => offer.id),
    type: text('type').notNull(), // one of the nine signal types
    label: text('label').notNull(),
    weight: integer('weight').notNull(), // points, 0 to 100
    match: textArray('match'), // keywords; empty means any signal of the type
    minValue: numeric('min_value', { precision: 8, scale: 4, mode: 'number' }),
    why: text('why').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    origin: text('origin').notNull().default('manual'), // default | manual
    sort: integer('sort').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('signal_rule_tenant_offer_idx').on(t.tenantId, t.offerId, t.sort)],
);
