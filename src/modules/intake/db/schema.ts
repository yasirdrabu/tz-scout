import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/**
 * Intake schema. Every table here is a tenant table: `tenant_id` not null, row level security
 * enabled and forced with the standard `tenant_isolation` policy (added by hand in the migration,
 * with the arrival immutability trigger). Trust history, outcomes and feedback arrive in R3.
 */
export const intake = pgSchema('intake');

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const at = (name: string) => timestamp(name, { withTimezone: true });
const now = (name: string) => at(name).notNull().defaultNow();

export const source = intake.table(
  'source',
  {
    id: text('id').primaryKey(), // src_
    tenantId: text('tenant_id').notNull(),
    kind: text('kind').notNull(), // person | agent | vendor | partner | crm | web_form | scheduled_pull
    name: text('name').notNull(),
    parentId: text('parent_id').references((): AnyPgColumn => source.id),
    userId: text('user_id'), // person sources: the tenant user
    status: text('status').notNull().default('active'), // active | paused | archived
    initialReviewStatusKey: text('initial_review_status_key'),
    dailyArrivalCap: integer('daily_arrival_cap').notNull().default(500),
    trust: numeric('trust', { precision: 5, scale: 4, mode: 'number' }).notNull().default(0.6),
    trustUpdatedAt: at('trust_updated_at'),
    settings: jsonb('settings').notNull().default({}),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [
    uniqueIndex('source_tenant_person_user_uq')
      .on(t.tenantId, t.userId)
      .where(sql`kind = 'person' and user_id is not null`),
    index('source_tenant_parent_idx').on(t.tenantId, t.parentId),
  ],
);

export const batch = intake.table('batch', {
  id: text('id').primaryKey(), // bat_
  tenantId: text('tenant_id').notNull(),
  personSourceId: text('person_source_id'),
  agentSourceId: text('agent_source_id'),
  vendorSourceId: text('vendor_source_id'),
  principal: text('principal').notNull(),
  name: text('name').notNull(),
  runAt: at('run_at').notNull().defaultNow(),
  notes: text('notes'),
  criteria: jsonb('criteria'),
  metadata: jsonb('metadata'),
  itemCount: integer('item_count').notNull().default(0),
  counts: jsonb('counts').notNull().default({}), // resolved, rejected, newAccounts, alreadyKnown
  status: text('status').notNull().default('processing'), // processing | completed
  completedAt: at('completed_at'),
  createdAt: now('created_at'),
});

export const arrival = intake.table(
  'arrival',
  {
    id: text('id').primaryKey(), // arr_
    tenantId: text('tenant_id').notNull(),
    batchId: text('batch_id').references(() => batch.id),
    personSourceId: text('person_source_id'),
    agentSourceId: text('agent_source_id'),
    vendorSourceId: text('vendor_source_id'),
    closestSourceId: text('closest_source_id').notNull(), // the agent, else the person, else the vendor
    principal: text('principal').notNull(),
    channel: text('channel').notNull(), // api | mcp | file | webhook | form | enrichment | web
    receivedAt: now('received_at'),
    contractVersion: text('contract_version').notNull().default('arrival.v1'),
    payload: jsonb('payload').notNull(), // immutable (trigger)
    payloadHash: text('payload_hash').notNull(), // immutable (trigger)
    externalRef: text('external_ref'), // null on a duplicate_in_batch rejection; the ref stays in payload.raw
    targetAccountId: text('target_account_id'),
    status: text('status').notNull().default('received'), // received | resolving | resolved | rejected
    waitingOn: text('waiting_on'), // needs_website | needs_company | possible_duplicate
    waitingSince: at('waiting_since'),
    rejectReason: text('reject_reason'),
    rejectDetail: text('reject_detail'),
    accountId: text('account_id'),
    resolution: text('resolution'), // created | attached
    duplicateCandidates: jsonb('duplicate_candidates'),
    resolutionInput: jsonb('resolution_input'), // what a person decided while the arrival waited
    normalised: jsonb('normalised'), // the output of step 2
    lockKey: text('lock_key'), // the resolve lock: domain, else name and country, else shell email
    steps: text('steps').array().notNull().default(sql`'{}'::text[]`), // pipeline steps already done
    warmIntroId: text('warm_intro_id'),
    canDeclareWarmIntro: boolean('can_declare_warm_intro').notNull().default(false), // the sender held warm_intro:declare
    resolvedAt: at('resolved_at'),
  },
  (t) => [
    uniqueIndex('arrival_tenant_source_ref_uq')
      .on(t.tenantId, t.closestSourceId, t.externalRef)
      .where(sql`external_ref is not null`),
    index('arrival_tenant_source_received_idx').on(t.tenantId, t.closestSourceId, t.receivedAt),
    index('arrival_tenant_status_waiting_idx').on(t.tenantId, t.status, t.waitingOn),
    index('arrival_tenant_batch_idx').on(t.tenantId, t.batchId),
    index('arrival_tenant_account_idx').on(t.tenantId, t.accountId),
  ],
);

export const batchFile = intake.table(
  'batch_file',
  {
    tenantId: text('tenant_id').notNull(),
    batchId: text('batch_id')
      .notNull()
      .references(() => batch.id),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(), // blob_, a file_blob row
    sha256: text('sha256').notNull(),
    createdAt: now('created_at'),
  },
  (t) => [primaryKey({ columns: [t.batchId, t.storageKey] })],
);

export const fileBlob = intake.table('file_blob', {
  storageKey: text('storage_key').primaryKey(), // blob_
  tenantId: text('tenant_id').notNull(),
  content: bytea('content').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  createdAt: now('created_at'),
});

export const fileImport = intake.table(
  'file_import',
  {
    id: text('id').primaryKey(), // imp_
    tenantId: text('tenant_id').notNull(),
    batchId: text('batch_id').references(() => batch.id),
    sourceId: text('source_id').notNull(),
    fileName: text('file_name').notNull(),
    storageKey: text('storage_key').notNull(), // blob_, the uploaded file
    layout: text('layout'),
    headers: jsonb('headers'),
    rowCount: integer('row_count'),
    mapping: jsonb('mapping'),
    mappingOrigin: text('mapping_origin'), // saved | ai | rules | person
    status: text('status').notNull().default('uploaded'),
    stats: jsonb('stats'),
    createdAt: now('created_at'),
    updatedAt: now('updated_at'),
  },
  (t) => [index('file_import_tenant_source_idx').on(t.tenantId, t.sourceId)],
);

export const columnMapping = intake.table(
  'column_mapping',
  {
    id: text('id').primaryKey(), // map_
    tenantId: text('tenant_id').notNull(),
    sourceId: text('source_id').notNull(),
    headerSignature: text('header_signature').notNull(),
    mapping: jsonb('mapping').notNull(),
    createdBy: text('created_by'),
    lastUsedAt: at('last_used_at'),
    createdAt: now('created_at'),
  },
  (t) => [uniqueIndex('column_mapping_tenant_source_sig_uq').on(t.tenantId, t.sourceId, t.headerSignature)],
);

export const warmIntro = intake.table(
  'warm_intro',
  {
    id: text('id').primaryKey(), // wi_
    tenantId: text('tenant_id').notNull(),
    arrivalId: text('arrival_id')
      .notNull()
      .references(() => arrival.id),
    accountId: text('account_id').notNull(),
    introducerUserId: text('introducer_user_id'),
    introducerName: text('introducer_name'),
    introducerEmail: text('introducer_email'),
    relationshipText: text('relationship_text'),
    relationshipKey: text('relationship_key').notNull(),
    note: text('note'),
    points: integer('points').notNull(), // full points, 0 to 20
    effectivePoints: integer('effective_points').notNull(), // what counts: half of points (rounded down) until confirmed
    confirmed: boolean('confirmed').notNull().default(false),
    confirmedBy: text('confirmed_by'),
    createdAt: now('created_at'),
  },
  (t) => [
    uniqueIndex('warm_intro_tenant_arrival_uq').on(t.tenantId, t.arrivalId),
    index('warm_intro_tenant_account_idx').on(t.tenantId, t.accountId),
  ],
);

export const warmIntroRule = intake.table(
  'warm_intro_rule',
  {
    tenantId: text('tenant_id').notNull(),
    introducerUserId: text('introducer_user_id'),
    introducerEmail: text('introducer_email'), // stored lowercase
    relationshipKey: text('relationship_key').notNull(),
    points: integer('points').notNull(),
  },
  (t) => [
    check('warm_intro_rule_one_introducer', sql`(${t.introducerUserId} is null) <> (${t.introducerEmail} is null)`),
    uniqueIndex('warm_intro_rule_user_uq')
      .on(t.tenantId, t.introducerUserId, t.relationshipKey)
      .where(sql`introducer_user_id is not null`),
    uniqueIndex('warm_intro_rule_email_uq')
      .on(t.tenantId, t.introducerEmail, t.relationshipKey)
      .where(sql`introducer_email is not null`),
  ],
);

export const relationshipDefault = intake.table(
  'relationship_default',
  {
    tenantId: text('tenant_id').notNull(),
    relationshipKey: text('relationship_key').notNull(),
    label: text('label').notNull(),
    points: integer('points').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.relationshipKey] })],
);
