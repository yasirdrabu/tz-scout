import { spawn } from 'node:child_process';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAll } from '@/platform/db/migrate';
import { freshDatabase } from '../helpers/db';

// The CLI seeds real-looking people, so it runs against its own database, not the shared test one.
let db: Awaited<ReturnType<typeof freshDatabase>>;
let client: ReturnType<typeof postgres>;
let adminDb: ReturnType<typeof drizzle>;
let dbEnv: Record<string, string>;

beforeAll(async () => {
  db = await freshDatabase(`scout_cli_${process.pid}`);
  await migrateAll({ adminUrl: db.adminUrl });
  client = postgres(db.adminUrl, { max: 1, onnotice: () => {} });
  adminDb = drizzle(client);
  dbEnv = { DATABASE_URL: db.appUrl, DATABASE_ADMIN_URL: db.adminUrl };
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 2 });
  await db?.drop();
});

type Result = { code: number | null; stdout: string; stderr: string };

/** Runs `scout <args>` as a child process (through tsx, which resolves the `@/` alias). */
function scout(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/entry/cli.ts', ...args], {
    env: { ...process.env, LOG_LEVEL: 'info', ...dbEnv, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (d) => (stdout += d));
  child.stderr!.on('data', (d) => (stderr += d));
  const done = new Promise<Result>((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  return { child, done, output: () => stdout + stderr };
}

/** Asks a running role to stop. Windows cannot deliver SIGTERM to a child, so it uses the same path over IPC. */
function stop(child: ReturnType<typeof spawn>) {
  if (process.platform === 'win32') child.send('shutdown');
  else child.kill('SIGTERM');
}

async function waitFor(fn: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('scout CLI', () => {
  it('seed twice leaves one taazaa tenant, one owner and one active dev key', async () => {
    expect((await scout(['seed']).done).code).toBe(0);
    const second = await scout(['seed']).done;
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('scout_test_');

    const tenants = await adminDb.execute(sql`select id from tenancy.tenant where slug = 'taazaa'`);
    expect(tenants).toHaveLength(1);
    const id = (tenants[0] as { id: string }).id;
    const owners = await adminDb.execute(
      sql`select 1 from tenancy.membership where tenant_id = ${id} and role = 'owner'`,
    );
    expect(owners).toHaveLength(1);
    const keys = await adminDb.execute(
      sql`select 1 from tenancy.api_key where tenant_id = ${id} and name = 'Local development key' and revoked_at is null`,
    );
    expect(keys).toHaveLength(1);
    const sched = await adminDb.execute(
      sql`select cron, timezone from platform.schedule where job_name = 'integrations.credentials.cleanup'`,
    );
    expect(sched).toHaveLength(1);
    expect(sched[0]).toMatchObject({ cron: '0 * * * *', timezone: 'UTC' });
  }, 90_000);

  it('seed leaves one development agent under the admin, a person source per user, and a key bound to the agent', async () => {
    const id = ((await adminDb.execute(sql`select id from tenancy.tenant where slug = 'taazaa'`)) as unknown as { id: string }[])[0]!.id;
    const agents = (await adminDb.execute(
      sql`select id, parent_id from intake.source where tenant_id = ${id} and kind = 'agent' and name = 'Local development agent'`,
    )) as unknown as { id: string; parent_id: string }[];
    expect(agents).toHaveLength(1);
    const parent = (await adminDb.execute(
      sql`select kind, user_id from intake.source where id = ${agents[0]!.parent_id}`,
    )) as unknown as { kind: string; user_id: string }[];
    expect(parent[0]!.kind).toBe('person');
    const users = (await adminDb.execute(
      sql`select email from tenancy.membership m join tenancy.user u on u.id = m.user_id where m.tenant_id = ${id}`,
    )) as unknown as { email: string }[];
    const people = (await adminDb.execute(sql`select user_id from intake.source where tenant_id = ${id} and kind = 'person'`)) as unknown as { user_id: string }[];
    expect(people.length).toBeGreaterThanOrEqual(users.length);
    expect(new Set(people.map((p) => p.user_id)).size).toBe(people.length);
    const key = (await adminDb.execute(
      sql`select source_id, scopes from tenancy.api_key where tenant_id = ${id} and name = 'Local development key' and revoked_at is null`,
    )) as unknown as { source_id: string; scopes: string[] }[];
    expect(key[0]!.source_id).toBe(agents[0]!.id);
    expect([...key[0]!.scopes].sort()).toEqual(
      ['accounts:read', 'accounts:write', 'arrivals:read', 'arrivals:write', 'imports:run', 'offers:read', 'people:write', 'signals:write', 'status:read'],
    );
    const vendors = await adminDb.execute(sql`select 1 from intake.source where tenant_id = ${id} and kind = 'vendor'`);
    expect(vendors.length).toBeGreaterThan(0);
  }, 30_000);

  it('seed twice leaves one scoring profile, one set of review statuses and the signal rules; backfill-r1b changes nothing more', async () => {
    // Seeds here rather than relying on an earlier test having done it.
    const seeded = await scout(['seed']).done;
    expect(seeded.code, seeded.stderr).toBe(0);
    const id = ((await adminDb.execute(sql`select id from tenancy.tenant where slug = 'taazaa'`)) as unknown as { id: string }[])[0]!.id;
    const read = async () => {
      const n = async (q: ReturnType<typeof sql>) => Number(((await adminDb.execute(q)) as unknown as { n: string }[])[0]!.n);
      return {
        profiles: await n(sql`select count(*) n from scoring.scoring_profile where tenant_id = ${id}`),
        statuses: await n(sql`select count(*) n from routing.review_status_def where tenant_id = ${id}`),
        reasons: await n(sql`select count(*) n from routing.decline_reason_def where tenant_id = ${id}`),
        settings: await n(sql`select count(*) n from routing.routing_setting where tenant_id = ${id}`),
        rules: await n(sql`select count(*) n from offers.signal_rule where tenant_id = ${id}`),
        schedules: await n(sql`select count(*) n from platform.schedule where tenant_id = ${id}`),
      };
    };
    const before = await read();
    expect(before).toMatchObject({ profiles: 1, statuses: 4, settings: 1 });
    expect(before.schedules).toBeGreaterThanOrEqual(2);
    expect(before.rules).toBeGreaterThan(0);
    const r = await scout(['backfill-r1b', 'taazaa']).done;
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Workspace taazaa is up to date.');
    expect(await read()).toEqual(before);
    const missing = await scout(['backfill-r1b', 'nowhere']).done;
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('No workspace with the slug "nowhere".');
  }, 90_000);

  it('seed twice leaves one CRM setting, one set of field mappings and one set of mock fixtures; backfill-r1c changes nothing more', async () => {
    const seeded = await scout(['seed']).done;
    expect(seeded.code, seeded.stderr).toBe(0);
    const id = ((await adminDb.execute(sql`select id from tenancy.tenant where slug = 'taazaa'`)) as unknown as { id: string }[])[0]!.id;
    const read = async () => {
      const n = async (q: ReturnType<typeof sql>) => Number(((await adminDb.execute(q)) as unknown as { n: string }[])[0]!.n);
      return {
        settings: await n(sql`select count(*) n from crm.setting where tenant_id = ${id}`),
        mappings: await n(sql`select count(*) n from crm.field_mapping where tenant_id = ${id}`),
        owners: await n(sql`select count(*) n from crm.mock_owner where tenant_id = ${id}`),
        companies: await n(sql`select count(*) n from crm.mock_company where tenant_id = ${id}`),
        contacts: await n(sql`select count(*) n from crm.mock_person where tenant_id = ${id}`),
        deals: await n(sql`select count(*) n from crm.mock_deal where tenant_id = ${id}`),
        schedules: await n(sql`select count(*) n from platform.schedule where tenant_id = ${id}`),
      };
    };
    const before = await read();
    expect(before).toMatchObject({ settings: 1, mappings: 11, companies: 5, contacts: 1, deals: 1 });
    expect(before.owners).toBeGreaterThanOrEqual(5);
    const r = await scout(['backfill-r1c', 'taazaa']).done;
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Workspace taazaa is up to date.');
    expect(await read()).toEqual(before);
    const again = await scout(['seed']).done;
    expect(again.code, again.stderr).toBe(0);
    expect(await read()).toEqual(before);
    const missing = await scout(['backfill-r1c', 'nowhere']).done;
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('No workspace with the slug "nowhere".');
  }, 120_000);

  it('import taazaa research-a.csv exits 0 and prints the batch', async () => {
    const r = await scout(['import', 'taazaa', 'tests/fixtures/imports/research-a.csv']).done;
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Batch bat_\w+: 4 rows, layout research, import imp_\w+ is queued\./);
    const batches = await adminDb.execute(sql`select 1 from intake.file_import where status = 'queued'`);
    expect(batches).toHaveLength(1);
  }, 60_000);

  it('import names an unknown workspace', async () => {
    const r = await scout(['import', 'nowhere', 'tests/fixtures/imports/research-a.csv']).done;
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No workspace with the slug "nowhere".');
  }, 60_000);

  it('keys:create prints a live key', async () => {
    const r = await scout(['keys:create', '--tenant', 'taazaa', '--name', 't', '--scopes', 'status:read']).done;
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^scout_live_/);
  }, 60_000);

  it('tenants:create makes a workspace', async () => {
    const r = await scout([
      'tenants:create', '--slug', 'cli-sample', '--name', 'Cli Sample', '--currency', 'USD',
      '--timezone', 'UTC', '--owner-email', 'owner@cli-sample.example',
    ]).done;
    expect(r.code).toBe(0);
    expect(await adminDb.execute(sql`select 1 from tenancy.tenant where slug = 'cli-sample'`)).toHaveLength(1);
  }, 60_000);

  it('refuses to seed in production', async () => {
    const r = await scout(['seed'], {
      NODE_ENV: 'production',
      SCOUT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      AUTH_SECRET: 'x'.repeat(32),
      APP_PUBLIC_URL: 'https://scout.example.test',
      NATS_URL: 'nats://localhost:4222',
      AUTH_DEV_SIGNIN: 'false',
    }).done;
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Seed data is for local use only.');
  }, 60_000);

  it.each(['worker', 'all-background'])('%s exits 0 within 10 seconds of a stop request', async (role) => {
    const p = scout([role]);
    await waitFor(() => /starting/.test(p.output()), 30_000);
    await new Promise((r) => setTimeout(r, 2000));
    const t0 = Date.now();
    stop(p.child);
    const r = await p.done;
    expect(r.code, r.stderr).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 60_000);
});
