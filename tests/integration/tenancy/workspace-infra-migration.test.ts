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

beforeAll(async () => {
  db = await freshDatabase(`scout_test_${process.pid}_workspace_infra`);
  await migrateAll({ adminUrl: db.adminUrl, folders: { tenancy: tenancyUpTo('0005_role_permission') } });
  sql = postgres(db.adminUrl, { max: 1, onnotice: () => {} });
  for (const id of ['t_old_a', 't_old_b']) {
    await sql`insert into tenancy.tenant (id, slug, name, currency, timezone) values (${id}, ${id.replace(/_/g, '-')}, ${id}, 'USD', 'UTC')`;
  }
  await migrateAll({ adminUrl: db.adminUrl });
});

afterAll(async () => {
  await sql?.end();
  await db.drop();
});

it('gives every existing tenant an active row in us-1 on the shared database', async () => {
  const rows = await sql`select tenant_id, region, database, status, schema_versions, quotas, test from tenancy.workspace_infra order by tenant_id`;
  expect(rows).toEqual([
    { tenant_id: 't_old_a', region: 'us-1', database: db.name, status: 'active', schema_versions: {}, quotas: {}, test: false },
    { tenant_id: 't_old_b', region: 'us-1', database: db.name, status: 'active', schema_versions: {}, quotas: {}, test: false },
  ]);
});
