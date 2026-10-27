import { sql } from 'drizzle-orm';
import { bigint, index, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Scoring schema. Every table here is a tenant table: `tenant_id` not null, row level security
 * enabled and forced with the standard `tenant_isolation` policy (added by hand in the migration).
 */
export const scoring = pgSchema('scoring');

const at = (name: string) => timestamp(name, { withTimezone: true });
const ratio = (name: string) => numeric(name, { precision: 5, scale: 4, mode: 'number' });

/** One row per tenant. Every change bumps `version` and publishes `scoring.rules.changed`. */
export const scoringProfile = scoring.table('scoring_profile', {
  tenantId: text('tenant_id').primaryKey(),
  fitWeight: ratio('fit_weight').notNull(),
  intentWeight: ratio('intent_weight').notNull(),
  fitParts: jsonb('fit_parts').notNull(), // maxes per part: industry, size, revenue, region, buyer
  halfLifeDays: integer('half_life_days').notNull(),
  maxSignalAgeDays: integer('max_signal_age_days').notNull(),
  tierThresholds: jsonb('tier_thresholds').notNull(),
  warmIntroCap: integer('warm_intro_cap').notNull(),
  trustModifierMax: integer('trust_modifier_max').notNull(),
  trustNeutral: ratio('trust_neutral').notNull(),
  researchFloorDays: integer('research_floor_days').notNull(),
  version: integer('version').notNull().default(1),
  updatedBy: text('updated_by'),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

/** One row per account per approved offer. Replaced on each scoring. */
export const offerMatch = scoring.table(
  'offer_match',
  {
    id: text('id').primaryKey(), // om_
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    offerId: text('offer_id').notNull(),
    fit: integer('fit').notNull(),
    intent: integer('intent').notNull(),
    matchTotal: integer('match_total').notNull(),
    tier: text('tier').notNull(), // not_fit | watch | good_fit | act_now
    fitParts: jsonb('fit_parts').notNull(),
    ruleHits: jsonb('rule_hits').notNull(),
    disqualifiedReason: text('disqualified_reason'),
    profileVersion: integer('profile_version').notNull(),
    computedAt: at('computed_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('offer_match_account_offer_uq').on(t.tenantId, t.accountId, t.offerId),
    index('offer_match_offer_idx').on(t.tenantId, t.offerId),
  ],
);

/** The current score for an account: the one every other module reads. */
export const accountScore = scoring.table(
  'account_score',
  {
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    bestOfferId: text('best_offer_id'),
    practiceId: text('practice_id'),
    fit: integer('fit').notNull(),
    intent: integer('intent').notNull(),
    matchTotal: integer('match_total').notNull(),
    warmPoints: integer('warm_points').notNull().default(0),
    warmIntroducerId: text('warm_introducer_id'),
    warmIntroducerName: text('warm_introducer_name'),
    trust: ratio('trust'),
    trustSourceId: text('trust_source_id'),
    trustModifier: integer('trust_modifier').notNull().default(0),
    priority: integer('priority').notNull(),
    tier: text('tier').notNull(),
    tierReason: text('tier_reason').notNull(), // computed | research_floor | warm_intro_floor
    revenuePotentialCents: bigint('revenue_potential_cents', { mode: 'number' }), // null until R2
    revenueBand: text('revenue_band'), // low | medium | high, null until R2
    explanation: jsonb('explanation').notNull(),
    inputsHash: text('inputs_hash').notNull(),
    profileVersion: integer('profile_version').notNull(),
    version: integer('version').notNull().default(1), // bumped on every real change
    computedAt: at('computed_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.accountId] })],
);

/** History, so "why did this move" has an answer. Kept 2 years. */
export const scoreChange = scoring.table(
  'score_change',
  {
    id: text('id').primaryKey(), // scc_
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    fromPriority: integer('from_priority'),
    toPriority: integer('to_priority').notNull(),
    fromTier: text('from_tier'),
    toTier: text('to_tier').notNull(),
    fromOfferId: text('from_offer_id'),
    toOfferId: text('to_offer_id'),
    cause: text('cause').notNull(), // new_signal | new_fact | rules_changed | offer_changed | trust_changed | warm_intro | manual_rescore
    causeEventId: text('cause_event_id'),
    at: at('at').notNull().defaultNow(),
  },
  (t) => [index('score_change_account_at_idx').on(t.tenantId, t.accountId, sql`${t.at} desc`)],
);
