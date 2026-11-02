import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { config } from '@/platform/config';
import { connect } from '@/platform/db/client';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

// D35: a workspace pool counts what runs on it, so the LRU never closes one under a transaction.
it('counts a transaction from begin to end and a query while it runs, through drizzle', async () => {
  const pool = connect(config.databaseAdminUrl, 2, 5);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  try {
    expect(pool.inUse()).toBe(0);
    const tx = pool.db.transaction(async (t) => {
      await t.execute(sql`select 1`);
      await gate; // open, between statements
    });
    await tick(100);
    expect(pool.inUse()).toBe(1);
    const query = pool.db.execute(sql`select pg_sleep(0.4)`).then(() => 'done');
    await tick(150);
    expect(pool.inUse()).toBe(2);
    expect(await query).toBe('done');
    expect(pool.inUse()).toBe(1);
    release();
    await tx;
    expect(pool.inUse()).toBe(0);
    // A builder query (drizzle's .values() path) and a failing one are released too.
    await pool.db.select({ one: sql<number>`1` }).from(sql`(select 1) t`);
    await expect(pool.db.execute(sql`select * from no_such_table`)).rejects.toThrow();
    expect(pool.inUse()).toBe(0);
  } finally {
    release();
    await pool.end();
  }
});
