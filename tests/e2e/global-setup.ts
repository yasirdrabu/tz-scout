import { execFileSync } from 'node:child_process';
import { startBackground } from './background';
import { E2E_PORT, e2eEnv } from './env';

const run = (arg: string) =>
  execFileSync(process.execPath, ['--import', 'tsx', 'tests/e2e/prepare-db.ts', arg], {
    stdio: 'inherit',
    env: { ...process.env, ...e2eEnv },
  });

/** Routes the specs visit first. next dev compiles a route on its first request, so we pay that here. */
const WARM_ROUTES = ['/signin', '/t/taazaa', '/admin/system'];

/** Requests each route once (redirects are fine: the route still compiles). The web server is already up. */
async function warmRoutes(): Promise<void> {
  for (const route of WARM_ROUTES) {
    try {
      await fetch(`http://localhost:${E2E_PORT}${route}`, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
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
  // Playwright starts the web server before global setup, so it is up by now.
  await warmRoutes();
  return async () => {
    await background.stop();
    run('drop');
  };
}
