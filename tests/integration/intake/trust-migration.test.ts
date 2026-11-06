import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrateAll, migrationsFolder } from '@/platform/db/migrate';
import { freshDatabase } from '../helpers/db';

/** The intake migrations up to and including `lastTag`, as their own folder. */
function intakeUpTo(lastTag: string): string {
  const real = migrationsFolder('intake');
  const journal = JSON.parse(readFileSync(path.join(real, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const keep = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === lastTag) + 1);
  const dir = mkdtempSync(path.join(tmpdir(), 'scout-intake-'));
  mkdirSync(path.join(dir, 'meta'));
  for (const e of keep) copyFileSync(path.join(real, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: keep }));
  return dir;
}

let db: Awaited<ReturnType<typeof freshDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await freshDatabase(`scout_test_${process.pid}_source_trust`);
  await migrateAll({ adminUrl: db.adminUrl, folders: { intake: intakeUpTo('0007_source_feedback_arrival_optional') } });
  sql = postgres(db.adminUrl, { max: 1, onnotice: () => {} });
  await sql`insert into intake.source (id, tenant_id, kind, name, trust) values ('src_old', 't_old', 'vendor', 'Old', 0.72)`;
  await migrateAll({ adminUrl: db.adminUrl });
});

afterAll(async () => {
  await sql?.end();
  await db.drop();
});

it('0008 gives existing sources the published trust default, an empty sample and a history table', async () => {
  const [s] = await sql`select trust, trust_published, trust_sample, trust_won from intake.source where id = 'src_old'`;
  expect(s).toMatchObject({ trust: '0.7200', trust_published: '0.6000', trust_sample: 0, trust_won: 0 });
  const [t] = await sql`select count(*)::int as n from intake.source_trust_history`;
  expect(t!.n).toBe(0);
});

it('source_trust_history is under row level security', async () => {
  const [r] = await sql`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'intake.source_trust_history'::regclass`;
  expect(r).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
});
