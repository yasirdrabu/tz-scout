import { sql } from 'drizzle-orm';
import { check, integer, pgSchema, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Playbooks schema. Every table here is a tenant table: `tenant_id` not null, row level security
 * enabled and forced with the standard `tenant_isolation` policy (added by hand in the migration).
 */
export const playbooks = pgSchema('playbooks');

const at = (name: string) => timestamp(name, { withTimezone: true });

/** One brief per account: Scout's recommendation, the opener, who to approach first, and the drafting state (Rulings 1 to 3). */
export const brief = playbooks.table(
  'brief',
  {
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id').notNull(),
    /** The lead offer the brief was written for. */
    offerId: text('offer_id'),
    mode: text('mode'), // live | mock | rules
    aiRunId: text('ai_run_id'),
    recommendationHeadline: text('recommendation_headline'),
    recommendationDetail: text('recommendation_detail'),
    recommendationOrigin: text('recommendation_origin'), // ai | rules
    openerSubject: text('opener_subject'),
    openerBody: text('opener_body'),
    openerOrigin: text('opener_origin'), // ai | rules
    whoFirstPersonId: text('who_first_person_id'),
    whoFirstTitle: text('who_first_title'),
    whoFirstReason: text('who_first_reason'),
    draftState: text('draft_state').notNull().default('not_drafted'), // not_drafted | drafting | ready
    requestedSeq: integer('requested_seq').notNull().default(0),
    draftedSeq: integer('drafted_seq').notNull().default(0),
    /** Set while the account has an open or accepted assignment: automatic redrafts stop. */
    frozenAt: at('frozen_at'),
    /** The open assignment that froze it; only that assignment's decline or withdrawal unfreezes it. */
    frozenByAssignmentId: text('frozen_by_assignment_id'),
    /** The latest request number that came from a person (manual: Claude at any tier, fresh). */
    manualSeq: integer('manual_seq').notNull().default(0),
    /** Edited sections a person asked a draft to overwrite, until a draft takes them. */
    pendingIncludeEdited: text('pending_include_edited').array().notNull().default(sql`'{}'::text[]`),
    /** Runs of the current draft job, counted in their own transaction so a run that times out still counts. */
    draftJobId: text('draft_job_id'),
    draftAttempts: integer('draft_attempts').notNull().default(0),
    lastError: text('last_error'),
    draftedAt: at('drafted_at'),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.accountId] }),
    check('brief_draft_state_valid', sql`${t.draftState} in ('not_drafted', 'drafting', 'ready')`),
    check('brief_mode_valid', sql`${t.mode} is null or ${t.mode} in ('live', 'mock', 'rules')`),
  ],
);

const sectionColumns = () => ({
  tenantId: text('tenant_id').notNull(),
  accountId: text('account_id').notNull(),
  key: text('key').notNull(),
  body: text('body').notNull(),
  /** `fct_`, `sig_` and `per_` ids the text rests on. */
  citations: text('citations').array().notNull().default(sql`'{}'::text[]`),
  origin: text('origin').notNull(), // ai | rules | human
  mode: text('mode'), // live | mock | rules; null for human
  aiRunId: text('ai_run_id'),
  offerId: text('offer_id'),
  /** A user id, or `key:<id>` for an API key. */
  editedBy: text('edited_by'),
  editedByName: text('edited_by_name'),
  editedAt: at('edited_at'),
  version: integer('version').notNull().default(1),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

/** One row per (account, key). A section a person wrote is never overwritten by a draft unless asked (Ruling 4). */
export const briefSection = playbooks.table('brief_section', sectionColumns(), (t) => [
  primaryKey({ columns: [t.tenantId, t.accountId, t.key] }),
  check('brief_section_origin_valid', sql`${t.origin} in ('ai', 'rules', 'human')`),
]);

/** Append only: the version a write replaced. */
export const briefSectionHistory = playbooks.table(
  'brief_section_history',
  { ...sectionColumns(), recordedAt: at('recorded_at').notNull().defaultNow() },
  (t) => [primaryKey({ columns: [t.tenantId, t.accountId, t.key, t.version] })],
);
