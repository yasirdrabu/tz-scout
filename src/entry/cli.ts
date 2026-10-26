import './registry';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bootstrapDatabase, migrateAll } from '@/platform/db/migrate';
import { closeDbs } from '@/platform/db/client';
import { log } from '@/platform/log';
import { connectNats } from '@/platform/nats/connection';
import { ensureStreams } from '@/platform/nats/streams';
import { runRelay } from '@/platform/relay';
import { startWorker } from '@/platform/runtime/worker';
import { runScheduler } from '@/platform/scheduler';
import { consumers, jobs } from './worker';

const USAGE = `Usage: scout <command>

Long-running roles (stop with SIGTERM or SIGINT)
  web                 Next.js standalone server (PORT, default 4240). In development use "npm run dev".
  worker              All NATS consumers and job handlers
  scheduler           Publishes due scheduled jobs (run exactly one)
  relay               Moves outbox rows to NATS (run exactly one active)
  all-background      Worker, scheduler and relay in one process (single-VM setups)

One-shot commands
  migrate             Bootstrap (when DATABASE_SUPERUSER_URL is set), then apply migrations
  seed                Local development data (refuses production)
  keys:create         --tenant <slug> --name <name> --scopes a,b [--test]
  tenants:create      --slug <s> --name <n> --currency <USD> --timezone <zone> --owner-email <email>
                      Operator command: run it on the server. It acts as a system platform admin.
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

function web(): Promise<number> {
  const server = path.resolve('.next/standalone/server.js');
  if (!existsSync(server)) {
    console.error('No web build found. Run "npm run build" first, or use "npm run dev" in development.');
    return Promise.resolve(1);
  }
  const child = spawn(process.execPath, [server], {
    stdio: 'inherit',
    env: { ...process.env, PORT: process.env.PORT ?? '4240', HOSTNAME: process.env.SCOUT_BIND_HOST ?? '0.0.0.0' },
  });
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => child.kill(s));
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}

async function migrate(): Promise<void> {
  if (process.env.DATABASE_SUPERUSER_URL) {
    await bootstrapDatabase();
    console.log('Database roles and schemas are ready.');
  }
  const { applied } = await migrateAll();
  console.log(`Applied ${applied} migration${applied === 1 ? '' : 's'}.`);
}

function need(values: Record<string, string | boolean | undefined>, name: string): string {
  const v = values[name];
  if (typeof v !== 'string' || !v) throw new Error(`Missing --${name}.\n\n${USAGE}`);
  return v;
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
    case 'migrate':
      await migrate();
      return 0;
    case 'seed': {
      const { seed } = await import('./seed');
      const { devApiKey } = await seed();
      console.log(`Seed data is ready.\nDev API key for taazaa (status:read, members:read): ${devApiKey}`);
      return 0;
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
