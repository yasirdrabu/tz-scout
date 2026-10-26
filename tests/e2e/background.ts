// The worker and relay for the e2e run. "Send test event" needs both. They run in one child process
// (tsx resolves the `@/` alias, which the Playwright runner does not for app code).
import { spawn } from 'node:child_process';
import { e2eEnv } from './env';

type Running = { stop: () => Promise<void> };

/** Starts the worker (platform jobs, including the ping) and the relay against the e2e database. */
export async function startBackground(): Promise<Running> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/e2e/background-main.ts'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...e2eEnv },
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker and relay did not start within 60 seconds.')), 60_000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Worker and relay exited early (code ${code}).`));
    });
  });
  return {
    stop: async () => {
      child.stdin.write('stop\n');
      child.stdin.end();
      const killer = setTimeout(() => child.kill(), 10_000);
      await exited;
      clearTimeout(killer);
    },
  };
}
