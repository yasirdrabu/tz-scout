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
