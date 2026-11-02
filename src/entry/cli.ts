import './registry';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { config } from '@/platform/config';
import { bootstrapDatabase, createDatabase, migrateAll, migrateControlPlane, migrateWorkspaceDatabase } from '@/platform/db/migrate';
import { urlForDatabase } from '@/platform/db/workspace-pools';
import { closeDbs } from '@/platform/db/client';
import { closeHealthConnections } from '@/platform/health';
import { log } from '@/platform/log';
import { connectNats } from '@/platform/nats/connection';
import { ensureStreams } from '@/platform/nats/streams';
import { runRelay } from '@/platform/relay';
import { startWorker } from '@/platform/runtime/worker';
import { runScheduler } from '@/platform/scheduler';
import { consumers, jobs } from './worker';

const USAGE = `Usage: scout <command>

Long-running roles (stop with SIGTERM or SIGINT)
  web                 HTTP server: API, sign-in, health checks and the web app (PORT, default 4240;
                      SCOUT_BIND_HOST, default 0.0.0.0). In development use "npm run dev".
  worker              All NATS consumers and job handlers
  scheduler           Publishes due scheduled jobs (run exactly one)
  relay               Moves outbox rows to NATS (run exactly one active)
  all-background      Worker, scheduler and relay in one process (single-VM setups)

One-shot commands
  migrate [--tenant <slug>]
                      Bootstrap (when DATABASE_SUPERUSER_URL is set), then apply migrations. With
                      SCOUT_WORKSPACE_DATABASES=per_workspace: the control plane, every workspace
                      database 4 at a time (or one, --tenant), then the template workspace database;
                      exits 1 when a workspace fails (it is marked failed, the others go on)
  seed                Local development data (refuses production)
  import <slug> <file>  Import a CSV or XLSX list into a workspace, as the platform admin's person source
  backfill-r1b <slug>   Give a workspace built before R1b its scoring and routing defaults, a review row for each account, and a rescore
  backfill-r1c <slug>   Give a workspace built before R1c its CRM defaults and schedules, a company check for each account, and its HubSpot links
  backfill-review-flow <slug>  Send a workspace's earlier lead offer picks to the account summary, so the offer filter finds them
  rescore             [--tenant <slug>]  Rescore every account in every active workspace, or in one; each change is recorded as a rules change
  keys:create         --tenant <slug> --name <name> --scopes a,b [--test]
  tenants:create      --slug <s> --name <n> --currency <USD> --timezone <zone> --owner-email <email>
                      Operator command: run it on the server. It acts as a system platform admin.
  tenant split <slug> | --all  [--settle-seconds 65]
                      Move a workspace (or every one still there) out of the shared database into its own
                      (SCOUT_WORKSPACE_DATABASES=per_workspace). Its requests get 503 while it moves.
`;

/** Aborts when the process is told to stop: SIGTERM, SIGINT, or an IPC "shutdown" message (Windows has no SIGTERM). */
function stopSignal(): AbortSignal {
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.on('message', (m) => {
    if (m === 'shutdown' || (m as { type?: string } | null)?.type === 'shutdown') stop();
  });
  return ac.signal;
}

async function prepareStreams(): Promise<void> {
  const nats = await connectNats();
  try {
    await ensureStreams(nats.jsm);
  } finally {
    await nats.nc.drain();
  }
}

async function runRoles(roles: Array<'worker' | 'scheduler' | 'relay'>): Promise<void> {
  const signal = stopSignal();
  // The scheduler only writes to the outbox, so it does not need streams.
  if (roles.includes('worker') || roles.includes('relay')) await prepareStreams();
  const running = roles.map((r) => {
    log.info(`${r}: starting`);
    if (r === 'worker') return startWorker({ consumers, jobs, signal });
    if (r === 'relay') return runRelay({ signal });
    return runScheduler({ signal });
  });
  await Promise.all(running);
  log.info('stopped');
}

/** The HTTP server (API, sign-in, health checks and the web app) until a stop signal; then a graceful close. */
async function web(): Promise<number> {
  const signal = stopSignal();
  const { startServer } = await import('@/http/server');
  const host = process.env.SCOUT_BIND_HOST ?? '0.0.0.0';
  const server = await startServer({ port: Number(process.env.PORT ?? 4240), host });
  log.info(`web: listening on http://${host}:${server.port}`);
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  log.info('web: stopping');
  await server.close();
  await closeHealthConnections();
  log.info('stopped');
  return 0;
}

async function migrate(tenantSlug?: string): Promise<number> {
  if (process.env.DATABASE_SUPERUSER_URL) {
    await bootstrapDatabase();
    console.log('Database roles and schemas are ready.');
  }
  const plural = (n: number) => `${n} migration${n === 1 ? '' : 's'}`;
  if (config.workspaceDatabases === 'shared') {
    const { applied } = await migrateAll();
    console.log(`Applied ${plural(applied)}.`);
    return 0;
  }
  const { listTenants, migrateWorkspaces } = await import('@/modules/tenancy');
  if (!tenantSlug) console.log(`Control plane: applied ${plural((await migrateControlPlane()).applied)}.`);
  const tenant = tenantSlug ? (await listTenants()).find((t) => t.slug === tenantSlug) : undefined;
  if (tenantSlug && !tenant) throw new Error(`No workspace with the slug "${tenantSlug}".`);
  const results = await migrateWorkspaces(tenant ? { tenantId: tenant.id } : {});
  for (const r of results) {
    const who = `${r.database} (${r.tenantIds.length === 1 ? r.tenantIds[0] : `${r.tenantIds.length} workspaces`})`;
    console.log('error' in r ? `Workspace database ${who}: FAILED, ${r.error}` : `Workspace database ${who}: applied ${plural(r.applied)}.`);
  }
  if (!tenantSlug) {
    // New workspaces are copied from it; made when missing, brought up to date after the others.
    const template = config.workspaceTemplateDatabase;
    const made = await createDatabase(template);
    const { applied } = await migrateWorkspaceDatabase(urlForDatabase(config.databaseAdminUrl, template));
    console.log(`Template workspace database ${template}${made ? ' (made)' : ''}: applied ${plural(applied)}.`);
  }
  return results.some((r) => 'error' in r) ? 1 : 0;
}

function need(values: Record<string, string | boolean | undefined>, name: string): string {
  const v = values[name];
  if (typeof v !== 'string' || !v) throw new Error(`Missing --${name}.\n\n${USAGE}`);
  return v;
}

/** Imports a file as the platform admin's person source and prints the batch. The worker does the rest. */
async function importFile(slug: string, file: string): Promise<number> {
  const { ADMIN_EMAIL } = await import('./seed');
  const { createImport, personSourceFor, registerSource } = await import('@/modules/intake');
  const { ensurePlatformAdmin, listTenants } = await import('@/modules/tenancy');
  const { withTenant } = await import('@/platform/db/tenant');
  const { newId } = await import('@/platform/ids');
  const tenant = (await listTenants()).find((t) => t.slug === slug);
  if (!tenant) throw new Error(`No workspace with the slug "${slug}".`);
  const bytes = await readFile(file);
  const adminId = await ensurePlatformAdmin(ADMIN_EMAIL);
  const result = await withTenant(tenant.id, async (tx) => {
    const base = { tenantId: tenant.id, actor: { kind: 'user' as const, id: adminId }, correlationId: newId('cor'), tx };
    const sourceId =
      (await personSourceFor(base, adminId)) ?? (await registerSource(base, { kind: 'person', name: ADMIN_EMAIL.split('@')[0]!, userId: adminId }, { namedAfterPerson: true })).id;
    return createImport(
      { ...base, access: { sourceId, dataLimit: { kind: 'all' } } },
      { fileName: path.basename(file), contentType: 'application/octet-stream', bytes },
    );
  });
  if (result.status === 'needs_sheet') {
    console.error(`The workbook has several sheets (${result.sheets.join(', ')}). Save the one you want as its own file and try again.`);
    return 1;
  }
  console.log(`Batch ${result.batchId}: ${result.rowCount} rows, layout ${result.layout ?? 'none'}, import ${result.id} is ${result.status}.`);
  if (result.status === 'needs_confirm') console.log('The columns need a person to confirm them in the web app. Nothing is sent until then.');
  return 0;
}

/** Brings a workspace built before R1b, R1c or the review flow up to date (see backfillR1b, backfillR1c, backfillReviewFlow). Safe to run again. */
async function backfillTenant(slug: string, release: 'r1b' | 'r1c' | 'review-flow'): Promise<number> {
  const { backfillR1b, backfillR1c, backfillReviewFlow } = await import('./seed');
  const backfill = release === 'r1b' ? backfillR1b : release === 'r1c' ? backfillR1c : backfillReviewFlow;
  const { ensurePlatformAdmin, listTenants } = await import('@/modules/tenancy');
  const { withTenant } = await import('@/platform/db/tenant');
  const { newId } = await import('@/platform/ids');
  const tenant = (await listTenants()).find((t) => t.slug === slug);
  if (!tenant) throw new Error(`No workspace with the slug "${slug}".`);
  const adminId = await ensurePlatformAdmin('system@scout.local');
  await withTenant(tenant.id, (tx) =>
    backfill({ tenantId: tenant.id, actor: { kind: 'system', id: adminId }, correlationId: newId('cor'), tx }),
  );
  const after = { r1b: 'Scores will refresh as the worker runs.', r1c: 'Company checks will run as the worker runs.', 'review-flow': 'The account summaries will update as the worker runs.' }[release];
  console.log(`Workspace ${slug} is up to date. ${after}`);
  return 0;
}

/** Moves one workspace, or every active one still in the shared database, into its own database (D35). */
async function splitTenants(slug: string | undefined, all: boolean, settleMs: number): Promise<number> {
  if (!slug && !all) throw new Error(`Name a workspace or pass --all.\n\n${USAGE}`);
  const { listTenants, splitWorkspace } = await import('@/modules/tenancy');
  const tenants = (await listTenants()).filter((t) => (slug ? t.slug === slug : true));
  if (slug && tenants.length === 0) throw new Error(`No workspace with the slug "${slug}".`);
  let failed = 0;
  for (const t of tenants) {
    try {
      const r = await splitWorkspace(t.id, { settleMs });
      if (r.outcome === 'skipped') console.log(`Workspace ${t.slug}: left as it is, ${r.reason}.`);
      else if (r.outcome === 'cleaned') console.log(`Workspace ${t.slug}: its last rows deleted from the shared database.`);
      else console.log(`Workspace ${t.slug}: moved to ${r.database}, ${r.copied.reduce((n, c) => n + c.rows, 0)} rows in ${r.copied.length} tables.`);
    } catch (e) {
      failed++;
      console.error(`Workspace ${t.slug}: not moved, ${(e as Error).message}`);
    }
  }
  return failed > 0 ? 1 : 0;
}

/** Queues a rescore of every account in one workspace, or in every active one. The worker does the scoring. */
async function rescoreTenants(slug: string | undefined): Promise<number> {
  const { requestRescore } = await import('@/modules/scoring');
  const { ensurePlatformAdmin, listTenants } = await import('@/modules/tenancy');
  const { withTenant } = await import('@/platform/db/tenant');
  const { newId } = await import('@/platform/ids');
  const all = await listTenants();
  const tenants = slug ? all.filter((t) => t.slug === slug) : all.filter((t) => t.status === 'active');
  if (slug && tenants.length === 0) throw new Error(`No workspace with the slug "${slug}".`);
  const adminId = await ensurePlatformAdmin('system@scout.local');
  for (const tenant of tenants) {
    await withTenant(tenant.id, (tx) =>
      requestRescore({ tenantId: tenant.id, actor: { kind: 'system', id: adminId }, correlationId: newId('cor'), tx }, {}, 'rules_changed'),
    );
    console.log(`Workspace ${tenant.slug}: rescore queued. Scores will refresh as the worker runs.`);
  }
  return 0;
}

/** Runs one command. Returns the exit code. */
export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'web':
      return web();
    case 'worker':
      await runRoles(['worker']);
      return 0;
    case 'scheduler':
      await runRoles(['scheduler']);
      return 0;
    case 'relay':
      await runRoles(['relay']);
      return 0;
    case 'all-background':
      await runRoles(['worker', 'scheduler', 'relay']);
      return 0;
    case 'migrate': {
      const { values } = parseArgs({ args: rest, options: { tenant: { type: 'string' } } });
      return migrate(values.tenant);
    }
    case 'seed': {
      const { seed } = await import('./seed');
      const { devApiKey } = await seed();
      console.log(`Seed data is ready.\nDev API key for taazaa (bound to the Local development agent): ${devApiKey}`);
      return 0;
    }
    case 'import': {
      const [slug, file] = rest;
      if (!slug || !file) throw new Error(`Usage: scout import <tenant-slug> <file>

${USAGE}`);
      return importFile(slug, file);
    }
    case 'backfill-r1b': {
      const [slug] = rest;
      if (!slug) throw new Error(`Usage: scout backfill-r1b <tenant-slug>

${USAGE}`);
      return backfillTenant(slug, 'r1b');
    }
    case 'backfill-r1c': {
      const [slug] = rest;
      if (!slug) throw new Error(`Usage: scout backfill-r1c <tenant-slug>

${USAGE}`);
      return backfillTenant(slug, 'r1c');
    }
    case 'backfill-review-flow': {
      const [slug] = rest;
      if (!slug) throw new Error(`Usage: scout backfill-review-flow <tenant-slug>

${USAGE}`);
      return backfillTenant(slug, 'review-flow');
    }
    case 'rescore': {
      const { values } = parseArgs({ args: rest, options: { tenant: { type: 'string' } } });
      return rescoreTenants(values.tenant);
    }
    case 'keys:create': {
      const { values } = parseArgs({
        args: rest,
        options: {
          tenant: { type: 'string' },
          name: { type: 'string' },
          scopes: { type: 'string' },
          test: { type: 'boolean', default: false },
        },
      });
      const { createKeyFromCli } = await import('@/modules/tenancy');
      const secret = await createKeyFromCli({
        tenantSlug: need(values, 'tenant'),
        name: need(values, 'name'),
        scopes: need(values, 'scopes').split(','),
        test: values.test === true,
      });
      console.log(secret);
      return 0;
    }
    case 'tenant': {
      const [sub, ...args] = rest;
      if (sub !== 'split') throw new Error(`Unknown command: tenant ${sub ?? ''}\n\n${USAGE}`);
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { all: { type: 'boolean' }, 'settle-seconds': { type: 'string' } } });
      const settle = values['settle-seconds'] ?? '65';
      if (!/^\d+$/.test(settle)) throw new Error(`--settle-seconds takes a whole number of seconds, 0 or more (not "${settle}").`);
      if (Number(settle) < 65) {
        console.warn(`--settle-seconds ${settle}: under 65, a running API or worker may still serve the workspace from its cache while it is copied. Only safe when no API or worker is running.`);
      }
      return splitTenants(values.all ? undefined : positionals[0], values.all === true, Number(settle) * 1000);
    }
    case 'tenants:create': {
      const { values } = parseArgs({
        args: rest,
        options: {
          slug: { type: 'string' },
          name: { type: 'string' },
          currency: { type: 'string' },
          timezone: { type: 'string' },
          'owner-email': { type: 'string' },
        },
      });
      const { createTenant, ensurePlatformAdmin } = await import('@/modules/tenancy');
      // Operator command, run on the server: acts as a system platform admin.
      const adminId = await ensurePlatformAdmin('system@scout.local');
      const r = await createTenant(
        { kind: 'system', id: adminId },
        {
          slug: need(values, 'slug'),
          name: need(values, 'name'),
          currency: need(values, 'currency'),
          timezone: need(values, 'timezone'),
          ownerEmail: need(values, 'owner-email'),
        },
      );
      console.log(`Created workspace ${r.tenantId}. The owner is invited and joins on first sign in.`);
      return 0;
    }
    default:
      console.error(command ? `Unknown command: ${command}\n\n${USAGE}` : USAGE);
      return command ? 2 : 0;
  }
}

if (process.argv[1] && /cli\.[cm]?[jt]s$/.test(process.argv[1])) {
  run(process.argv.slice(2)).then(
    async (code) => {
      await closeDbs().catch(() => undefined);
      process.exit(code);
    },
    async (e) => {
      console.error((e as Error).message);
      await closeDbs().catch(() => undefined);
      process.exit(1);
    },
  );
}
