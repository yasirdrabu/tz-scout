import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { adminDb } from '@/platform/db/client';

/**
 * Platform-wide tables that keep `tenant_id` only for tracing. The relay, workers and scheduler
 * read them across tenants through adminDb, so they are deliberately not tenant-isolated.
 */
const PLATFORM_WIDE = new Set([
  'platform.outbox',
  'platform.processed_event',
  'platform.dead_job',
  'platform.schedule',
  'platform.delivery_attempt',
  'platform.ping_result',
]);

/** Schemas where every table must be tenant-scoped, with no exceptions beyond the allowlist. */
const STRICT_SCHEMAS = ['offers', 'accounts', 'intake', 'scoring'];

it('every table with a tenant_id forces row level security, except the platform-wide allowlist', async () => {
  const rows = await adminDb.execute<{ name: string; rls: boolean; forced: boolean }>(sql`
    select n.nspname || '.' || c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
    where c.relkind in ('r', 'p')
      and n.nspname in ('platform', 'tenancy', 'integrations', 'ai', 'offers', 'accounts', 'intake', 'scoring')
    order by 1`);
  expect(rows.length).toBeGreaterThan(0);
  const offenders = rows.filter((r) => !PLATFORM_WIDE.has(r.name) && !(r.rls && r.forced)).map((r) => r.name);
  expect(offenders, `tables with tenant_id but without forced row level security: ${offenders.join(', ')}`).toEqual([]);
  expect(rows.map((r) => r.name)).toContain('platform.idempotency_key');
});

it('every table in the offers, accounts, intake and scoring schemas has tenant_id and forced row level security', async () => {
  const rows = await adminDb.execute<{ name: string; has_tenant: boolean; rls: boolean; forced: boolean }>(sql`
    select n.nspname || '.' || c.relname as name,
      exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) as has_tenant,
      c.relrowsecurity as rls, c.relforcerowsecurity as forced
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and c.relname <> '__migrations'
      and n.nspname in (${sql.join(
        STRICT_SCHEMAS.map((s) => sql`${s}`),
        sql`, `,
      )})
    order by 1`);
  const offenders = rows.filter((r) => !PLATFORM_WIDE.has(r.name) && !(r.has_tenant && r.rls && r.forced)).map((r) => r.name);
  expect(offenders, `tables without tenant_id or forced row level security: ${offenders.join(', ')}`).toEqual([]);
  expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(['offers.practice', 'offers.offer', 'offers.case_study', 'offers.offer_case_study', 'offers.signal_rule']));
});

it('the allowlist only names tables that exist', async () => {
  const rows = await adminDb.execute<{ name: string }>(sql`
    select n.nspname || '.' || c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname = 'platform'`);
  const names = new Set(rows.map((r) => r.name));
  expect([...PLATFORM_WIDE].filter((t) => !names.has(t))).toEqual([]);
});
