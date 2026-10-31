import { execFileSync } from 'node:child_process';
import { startBackground } from './background';
import { e2eEnv } from './env';

const run = (arg: string) =>
  execFileSync(process.execPath, ['--import', 'tsx', 'tests/e2e/prepare-db.ts', arg], {
    stdio: 'inherit',
    env: { ...process.env, ...e2eEnv },
  });

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
  return async () => {
    await background.stop();
    run('drop');
  };
}
