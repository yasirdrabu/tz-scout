import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '@/platform/config';
import type { Tx } from './tenant';

export type Db = PostgresJsDatabase<Record<string, never>>;

function lazy(connect: () => Db): Db {
  let instance: Db | undefined;
  const get = (): Db => (instance ??= connect());
  return new Proxy({} as Db, {
    get: (_t, prop) => {
      const target = get();
      const value = Reflect.get(target, prop, target);
      // $client is the postgres.js Sql function; it carries .end, so it must not be bound.
      return typeof value === 'function' && prop !== '$client' ? value.bind(target) : value;
    },
  });
}

/**
 * Runtime connection as `scout_app`. Subject to row level security: tenant data is
 * only visible inside `withTenant`.
 */
export const appDb: Db = lazy(() =>
  drizzle(postgres(config.databaseUrl, { max: config.databasePoolMax, onnotice: () => {} })),
);

/**
 * Connection as `scout_admin` (bypasses row level security). For migrations,
 * platform-admin work and cross-tenant jobs only. Never use it on a request path
 * that serves one tenant.
 */
export const adminDb: Db = lazy(() => drizzle(postgres(config.databaseAdminUrl, { onnotice: () => {} })));

/**
 * Runs `fn` in a savepoint of `tx` when one is given (a platform admin request's `adminDb`
 * transaction, so the request holds one connection), else in a new `adminDb` transaction.
 */
export function adminTransaction<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return tx ? tx.transaction(fn) : adminDb.transaction(fn);
}

/** Close both pools. Only needed by scripts and tests. Safe to call when never used. */
export async function closeDbs(): Promise<void> {
  await Promise.allSettled([
    (appDb as unknown as { $client: postgres.Sql }).$client.end(),
    (adminDb as unknown as { $client: postgres.Sql }).$client.end(),
  ]);
}
