import type { Tx } from './tenant';

const RETRYABLE = new Set(['40P01', '40001']); // deadlock detected, serialization failure

/** Postgres aborted the work for a reason that goes away on its own. Drizzle wraps the driver's error, so the SQLSTATE may be on the cause. */
export function isRetryableTxError(e: unknown): boolean {
  const o = (e && typeof e === 'object' ? e : {}) as { code?: unknown; cause?: { code?: unknown } };
  const code = typeof o.code === 'string' ? o.code : typeof o.cause?.code === 'string' ? o.cause.code : null;
  return code !== null && RETRYABLE.has(code);
}

/**
 * Runs `fn` in a savepoint of the open transaction and runs it again, up to `attempts` times with a short
 * jittered pause, when Postgres aborts it with a deadlock or serialization failure. Rolling back to the
 * savepoint frees the locks the attempt took, so the other side proceeds. Anything else is thrown at once.
 */
export async function retryTransient<T>(
  tx: Tx,
  fn: (tx: Tx) => Promise<T>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await tx.transaction((sp) => fn(sp as Tx));
    } catch (e) {
      if (attempt >= attempts || !isRetryableTxError(e)) throw e;
      await sleep(20 * attempt + Math.floor(Math.random() * 40));
    }
  }
}
