import { sql } from 'drizzle-orm';
import { bigserial, boolean, index, jsonb, integer, pgSchema, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Platform schema. Most platform tables are platform-wide and EXEMPT from row level security
 * (no tenant policy): the relay and consumers read across tenants. `tenant_id` is still
 * stored so rows can be traced to a tenant. Tables that hold tenant data (`audit_log`,
 * `idempotency_key`) force the tenant_isolation policy; tests/integration/platform/rls-catalog
 * keeps the exempt list.
 */
export const platform = pgSchema('platform');

export const outbox = platform.table(
  'outbox',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    id: text('id').notNull().unique(),
    tenantId: text('tenant_id').notNull(),
    kind: text('kind').notNull(), // 'event' | 'job'
    natsSubject: text('nats_subject').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [index('outbox_unsent_idx').on(t.seq).where(sql`${t.sentAt} is null`)],
);

export const processedEvent = platform.table(
  'processed_event',
  {
    consumerName: text('consumer_name').notNull(),
    eventId: text('event_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumerName, t.eventId] })],
);

export const idempotencyKey = platform.table(
  'idempotency_key',
  {
    tenantId: text('tenant_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

/**
 * Jobs and consumer messages that failed on their last delivery. Platform-wide (RLS exempt):
 * read and written only through `adminDb` by the worker and platform admins.
 */
export const deadJob = platform.table(
  'dead_job',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    consumerOrJob: text('consumer_or_job').notNull(),
    envelope: jsonb('envelope').notNull(),
    lastError: text('last_error').notNull(),
    attempts: integer('attempts').notNull(),
    deadAt: timestamp('dead_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('dead_job_dead_at_idx').on(t.deadAt),
    // One dead row per message per consumer or job, even when two workers dead-letter it at once.
    uniqueIndex('dead_job_envelope_uq').on(t.consumerOrJob, sql`(${t.envelope}->>'id')`),
  ],
);

/** Round trips of the `platform.ping` diagnostic job. Platform-wide (RLS exempt). Id = the job id. */
export const pingResult = platform.table('ping_result', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
  handledAt: timestamp('handled_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Handler runs per message per consumer or job, kept outside the handler's transaction so a
 * failed run still counts. Deliveries put back because they were busy (lock contention) do not
 * run the handler and are not counted. Row deleted when the message is done. Platform-wide (RLS
 * exempt), written through `adminDb` by the worker.
 */
export const deliveryAttempt = platform.table(
  'delivery_attempt',
  {
    consumerName: text('consumer_name').notNull(),
    eventId: text('event_id').notNull(),
    runAttempts: integer('run_attempts').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumerName, t.eventId] })],
);

/**
 * Cron schedules that publish jobs through the outbox. Platform-wide (RLS exempt): the scheduler
 * reads across tenants through `adminDb`. `tenant_id` is `t_platform` for platform-level jobs.
 */
export const schedule = platform.table(
  'schedule',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    jobName: text('job_name').notNull(),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    payload: jsonb('payload').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('schedule_tenant_job_uq').on(t.tenantId, t.jobName),
    index('schedule_due_idx').on(t.nextRunAt).where(sql`enabled`),
  ],
);

/**
 * Who changed what. TENANT-SCOPED (row level security on, forced): module code writes and reads
 * it as `scout_app` inside `withTenant`. Platform-wide rows use tenant `t_platform` and go
 * through `adminDb`. Append only by convention: nothing updates or deletes these rows.
 */
export const auditLog = platform.table(
  'audit_log',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    sourceId: text('source_id'),
    apiKeyId: text('api_key_id'),
    /** True when a platform admin made the change under support access. */
    supportAccess: boolean('support_access').notNull().default(false),
    action: text('action').notNull(),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    correlationId: text('correlation_id'),
    ip: text('ip'),
    before: jsonb('before'),
    after: jsonb('after'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_tenant_at_idx').on(t.tenantId, t.at.desc(), t.id.desc()),
    index('audit_log_actor_idx').on(t.tenantId, t.actorId),
    index('audit_log_subject_idx').on(t.tenantId, t.subjectId),
  ],
);
