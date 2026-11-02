import { describe, expect, it } from 'vitest';
import { isRetryableTxError, retryTransient } from '@/platform/db/retry';
import type { Tx } from '@/platform/db/tenant';

/** A transaction whose savepoint just runs the function. */
const fakeTx = { transaction: async (fn: (sp: unknown) => Promise<unknown>) => fn(fakeTx) } as unknown as Tx;
const pg = (code: string) => Object.assign(new Error('pg'), { code });
const noSleep = async () => undefined;

describe('retryTransient', () => {
  it('recognises a deadlock and a serialization failure, also on the cause', () => {
    expect(isRetryableTxError(pg('40P01'))).toBe(true);
    expect(isRetryableTxError(pg('40001'))).toBe(true);
    expect(isRetryableTxError(new Error('wrapped', { cause: pg('40P01') }))).toBe(true);
    expect(isRetryableTxError(Object.assign(new Error('wrapped'), { cause: { code: '40001' } }))).toBe(true);
    expect(isRetryableTxError(pg('23505'))).toBe(false);
    expect(isRetryableTxError(null)).toBe(false);
  });

  it('runs again after a deadlock and returns the result', async () => {
    let calls = 0;
    const out = await retryTransient(fakeTx, async () => {
      if (++calls < 3) throw pg('40P01');
      return 'saved';
    }, { sleep: noSleep });
    expect(out).toBe('saved');
    expect(calls).toBe(3);
  });

  it('gives up after three attempts with the last error', async () => {
    let calls = 0;
    await expect(retryTransient(fakeTx, async () => { calls++; throw pg('40001'); }, { sleep: noSleep })).rejects.toMatchObject({ code: '40001' });
    expect(calls).toBe(3);
  });

  it('does not retry any other error, and pauses between attempts', async () => {
    let calls = 0;
    await expect(retryTransient(fakeTx, async () => { calls++; throw pg('23505'); }, { sleep: noSleep })).rejects.toMatchObject({ code: '23505' });
    expect(calls).toBe(1);
    const pauses: number[] = [];
    await retryTransient(fakeTx, async () => { if (pauses.length < 2) throw pg('40P01'); }, { sleep: async (ms) => void pauses.push(ms) });
    expect(pauses).toHaveLength(2);
    expect(pauses.every((ms) => ms >= 20 && ms < 140)).toBe(true);
  });
});
