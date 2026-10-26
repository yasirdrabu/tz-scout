import { sql } from 'drizzle-orm';
import { appDb } from './client';

export type Tx = Parameters<Parameters<typeof appDb.transaction>[0]>[0];

/**
 * Runs `fn` in a transaction on `appDb` with the tenant set for row level security.
 * The setting is transaction-local, so it cannot leak to another request on the
 * same pooled connection.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return appDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
