import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAll, MODULE_ORDER } from '@/platform/db/migrate';
import { freshDatabase } from '../helpers/db';

function emptyMigrations(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scout-mig-'));
  mkdirSync(path.join(dir, 'meta'));
  writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries: [] }));
  return dir;
}

function probeMigrations(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scout-mig-'));
  mkdirSync(path.join(dir, 'meta'));
  writeFileSync(path.join(dir, '0000_probe.sql'), 'create table ai.migrate_probe (id text primary key, tenant_id text not null);\n');
  writeFileSync(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [{ idx: 0, version: '7', when: 1700000000000, tag: '0000_probe', breakpoints: true }],
    }),
  );
  return dir;
}

describe('migrateAll', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  beforeAll(async () => {
    db = await freshDatabase(`scout_test_${process.pid}_mig`);
  });
  afterAll(async () => {
    await db.drop();
  });

  it('orders modules platform, tenancy, integrations, ai, offers', () => {
    expect([...MODULE_ORDER]).toEqual(['platform', 'tenancy', 'integrations', 'ai', 'offers']);
  });

  it('applies a migration once and applies 0 on the second run', async () => {
    // Isolate from real migrations.
    const folders = {
      platform: emptyMigrations(),
      tenancy: emptyMigrations(),
      integrations: emptyMigrations(),
      ai: probeMigrations(),
      offers: emptyMigrations(),
    };
    const count = async () => {
      const sql = postgres(db.adminUrl, { max: 1 });
      try {
        const r = await sql`select count(*)::int as n from ai.__migrations`;
        return r[0]!.n as number;
      } finally {
        await sql.end();
      }
    };
    const first = await migrateAll({ adminUrl: db.adminUrl, folders });
    expect(first.applied).toBe(1);
    expect(await count()).toBe(1);
    const second = await migrateAll({ adminUrl: db.adminUrl, folders });
    expect(second.applied).toBe(0);
    expect(await count()).toBe(1);
  });

  it('throws when a module has no migration journal', async () => {
    await expect(migrateAll({ adminUrl: db.adminUrl, folders: { offers: '/nonexistent' } })).rejects.toThrow(
      /offers.*no migration journal/i,
    );
  });
});
