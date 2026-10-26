import { execFileSync } from 'node:child_process';
import { e2eEnv } from './env';

const run = (arg: string) =>
  execFileSync(process.execPath, ['--import', 'tsx', 'tests/e2e/prepare-db.ts', arg], {
    stdio: 'inherit',
    env: { ...process.env, ...e2eEnv },
  });

/** Creates a fresh `scout_e2e` database, migrates it and seeds it. Dropped when the run ends. */
export default async function globalSetup() {
  run('create');
  return async () => {
    run('drop');
  };
}
