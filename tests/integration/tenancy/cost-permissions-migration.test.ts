import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrateAll, migrationsFolder } from '@/platform/db/migrate';
import { freshDatabase } from '../helpers/db';

/** The tenancy migrations up to and including `lastTag`, as their own folder. */
function tenancyUpTo(lastTag: string): string {
  const real = migrationsFolder('tenancy');
  const journal = JSON.parse(readFileSync(path.join(real, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const keep = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === lastTag) + 1);
  const dir = mkdtempSync(path.join(tmpdir(), 'scout-tenancy-'));
  mkdirSync(path.join(dir, 'meta'));
  for (const e of keep) copyFileSync(path.join(real, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: keep }));
  return dir;
}

let db: Awaited<ReturnType<typeof freshDatabase>>;
let sql: postgres.Sql;
const saved = {
  leader: ['accounts:read', 'analytics:read'],
  operator: ['accounts:read', 'costs:write'],
  seller: ['accounts:read'],
};

beforeAll(async () => {
  db = await freshDatabase(`scout_test_${process.pid}_cost_permissions`);
  await migrateAll({ adminUrl: db.adminUrl, folders: { tenancy: tenancyUpTo('0008_workspace_failure') } });
  sql = postgres(db.adminUrl, { max: 1, onnotice: () => {} });
  await sql`insert into tenancy.tenant (id, slug, name, currency, timezone) values ('t_saved', 't-saved', 'Saved', 'USD', 'UTC')`;
  for (const [role, permissions] of Object.entries(saved)) {
    await sql`insert into tenancy.role_permission (tenant_id, role, permissions) values ('t_saved', ${role}, ${permissions})`;
  }
  // A leader set that already has one of them keeps a single copy.
  await sql`insert into tenancy.tenant (id, slug, name, currency, timezone) values ('t_half', 't-half', 'Half', 'USD', 'UTC')`;
  await sql`insert into tenancy.role_permission (tenant_id, role, permissions) values ('t_half', 'leader', ${['costs:read']})`;
  await migrateAll({ adminUrl: db.adminUrl, folders: { tenancy: tenancyUpTo('0009_cost_permissions') } });
});

afterAll(async () => {
  await sql?.end();
  await db.drop();
});

const permsOf = async (tenantId: string, role: string) =>
  ((await sql`select permissions from tenancy.role_permission where tenant_id = ${tenantId} and role = ${role}`)[0]!.permissions as string[]);

it('adds costs:read to saved leader and operator sets and budgets:write to saved leader sets', async () => {
  expect(await permsOf('t_saved', 'leader')).toEqual([...saved.leader, 'costs:read', 'budgets:write']);
  expect(await permsOf('t_saved', 'operator')).toEqual([...saved.operator, 'costs:read']);
  expect(await permsOf('t_saved', 'seller')).toEqual(saved.seller);
});

it('adds only what is missing, once', async () => {
  expect(await permsOf('t_half', 'leader')).toEqual(['costs:read', 'budgets:write']);
  await sql.unsafe(readFileSync(path.join(migrationsFolder('tenancy'), '0009_cost_permissions.sql'), 'utf8').replaceAll('--> statement-breakpoint', ''));
  expect(await permsOf('t_half', 'leader')).toEqual(['costs:read', 'budgets:write']);
  expect(await permsOf('t_saved', 'operator')).toEqual([...saved.operator, 'costs:read']);
});
