import { sql } from 'drizzle-orm';
import { bigserial, index, jsonb, integer, pgSchema, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Platform schema. Platform tables are platform-wide and EXEMPT from row level security
 * (no tenant policy): the relay and consumers read across tenants. `tenant_id` is still
 * stored so rows can be traced to a tenant.
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
