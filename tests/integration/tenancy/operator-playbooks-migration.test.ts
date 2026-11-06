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
  operator: ['accounts:read', 'playbooks:read'],
  seller: ['accounts:read'],
};

beforeAll(async () => {
  db = await freshDatabase(`scout_test_${process.pid}_operator_playbooks`);
  await migrateAll({ adminUrl: db.adminUrl, folders: { tenancy: tenancyUpTo('0009_cost_permissions') } });
  sql = postgres(db.adminUrl, { max: 1, onnotice: () => {} });
  await sql`insert into tenancy.tenant (id, slug, name, currency, timezone) values ('t_saved', 't-saved', 'Saved', 'USD', 'UTC')`;
  for (const [role, permissions] of Object.entries(saved)) {
    await sql`insert into tenancy.role_permission (tenant_id, role, permissions) values ('t_saved', ${role}, ${permissions})`;
  }
  // An operator set that already has it keeps a single copy.
  await sql`insert into tenancy.tenant (id, slug, name, currency, timezone) values ('t_has', 't-has', 'Has', 'USD', 'UTC')`;
  await sql`insert into tenancy.role_permission (tenant_id, role, permissions) values ('t_has', 'operator', ${['playbooks:write']})`;
  await migrateAll({ adminUrl: db.adminUrl });
});

afterAll(async () => {
  await sql?.end();
  await db.drop();
});

const permsOf = async (tenantId: string, role: string) =>
  ((await sql`select permissions from tenancy.role_permission where tenant_id = ${tenantId} and role = ${role}`)[0]!.permissions as string[]);

it('adds playbooks:write to saved operator sets only', async () => {
  expect(await permsOf('t_saved', 'operator')).toEqual([...saved.operator, 'playbooks:write']);
  expect(await permsOf('t_saved', 'seller')).toEqual(saved.seller);
});

it('adds it only where missing, once', async () => {
  expect(await permsOf('t_has', 'operator')).toEqual(['playbooks:write']);
  await sql.unsafe(readFileSync(path.join(migrationsFolder('tenancy'), '0010_operator_playbooks_write.sql'), 'utf8'));
  expect(await permsOf('t_saved', 'operator')).toEqual([...saved.operator, 'playbooks:write']);
});
