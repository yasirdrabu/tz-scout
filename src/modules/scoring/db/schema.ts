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
  weights: jsonb('weights').notNull().default(sql`'{"fit":40,"intent":25,"revenue":15,"trust":20}'::jsonb`), // fit, intent, revenue, trust: 0 to 60 in fives, adding to 100
  fitParts: jsonb('fit_parts').notNull(), // maxes per part: industry, size, revenue, region, buyer
  halfLifeDays: integer('half_life_days').notNull(),
  maxSignalAgeDays: integer('max_signal_age_days').notNull(),
  tierCutoffs: jsonb('tier_cutoffs').notNull().default(sql`'{"actNow":75,"goodFit":55,"watch":35}'::jsonb`), // lowest score of act now, good fit, watch
  warmIntroCap: integer('warm_intro_cap').notNull(),
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
    revenueScore: integer('revenue_score'), // null on matches scored before the four-weight model
    trustScore: integer('trust_score'),
    matchTotal: integer('match_total').notNull(), // the match score
    tier: text('tier').notNull(), // not_fit | nurture | watch | good_fit | act_now
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
    revenueScore: integer('revenue_score'),
    trustScore: integer('trust_score'),
    matchTotal: integer('match_total').notNull(), // the best match's score
    warmPoints: integer('warm_points').notNull().default(0),
    warmIntroducerId: text('warm_introducer_id'),
    warmIntroducerName: text('warm_introducer_name'),
    trust: ratio('trust'),
    trustSourceId: text('trust_source_id'),
    trustModifier: integer('trust_modifier').notNull().default(0), // written 0 since the four-weight model; trust is a weighted score
    priority: integer('priority').notNull(),
    tier: text('tier').notNull(),
    tierReason: text('tier_reason').notNull(), // computed | research_floor | warm_intro_floor
    /** The tier Scout scored (after floors). `tier` is this unless a person set one by hand (Decision 4). */
    scoredTier: text('scored_tier').notNull(),
    /** A tier a person set by hand; kept across rescores until someone picks Scout's tier again. */
    tierOverride: text('tier_override'),
    tierOverrideBy: text('tier_override_by'),
    tierOverrideAt: at('tier_override_at'),
    tierOverrideNote: text('tier_override_note'),
    revenuePotentialCents: bigint('revenue_potential_cents', { mode: 'number' }), // the best offer's, null with no deal size
    revenueBand: text('revenue_band'), // low | medium | high
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
    cause: text('cause').notNull(), // new_signal | new_fact | rules_changed | offer_changed | trust_changed | warm_intro | manual_rescore | ageing
    causeEventId: text('cause_event_id'),
    /** Who changed it by hand (cause `tier_override`); null when Scout did. */
    by: text('by'),
    note: text('note'),
    at: at('at').notNull().defaultNow(),
  },
  (t) => [index('score_change_account_at_idx').on(t.tenantId, t.accountId, sql`${t.at} desc`)],
);
