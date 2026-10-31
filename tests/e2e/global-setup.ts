import { execFileSync } from 'node:child_process';
import { startBackground } from './background';
import { E2E_PORT, e2eEnv } from './env';

const run = (arg: string) =>
  execFileSync(process.execPath, ['--import', 'tsx', 'tests/e2e/prepare-db.ts', arg], {
    stdio: 'inherit',
    env: { ...process.env, ...e2eEnv },
  });

/**
 * Backend routes the specs call first. next dev compiles a route on its first request, so we pay that
 * here (a 401 is fine: the route still compiles).
 */
const WARM_ROUTES = [
  `http://localhost:${E2E_PORT}/api/v1/auth/config`,
  `http://localhost:${E2E_PORT}/api/v1/dev/users`,
  `http://localhost:${E2E_PORT}/api/v1/me`,
  `http://localhost:${E2E_PORT}/api/v1/me/counts`,
  `http://localhost:${E2E_PORT}/api/v1/members`,
  `http://localhost:${E2E_PORT}/api/v1/integrations`,
  `http://localhost:${E2E_PORT}/api/v1/api-keys`,
  `http://localhost:${E2E_PORT}/api/v1/audit`,
  `http://localhost:${E2E_PORT}/api/v1/admin/tenants`,
  `http://localhost:${E2E_PORT}/api/v1/admin/health`,
];

/** Requests each route once. The web servers are already up. */
async function warmRoutes(): Promise<void> {
  for (const route of WARM_ROUTES) {
    try {
      await fetch(route, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      console.warn(`warm-up of ${route} failed: ${(e as Error).message}`);
    }
  }
}

/**
 * Creates a fresh `scout_e2e` database, migrates it and seeds it, then starts the worker and relay
 * against it. Everything is stopped and the database dropped when the run ends.
 */
export default async function globalSetup() {
  run('create');
  let background: Awaited<ReturnType<typeof startBackground>>;
  try {
    background = await startBackground();
  } catch (e) {
    run('drop');
    throw e;
  }
  // Playwright starts the web servers before global setup, so they are up by now.
  await warmRoutes();
  return async () => {
    await background.stop();
    run('drop');
  };
}
