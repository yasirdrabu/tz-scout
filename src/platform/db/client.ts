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

const pools: Db[] = [];

/** A lazily connected pool, closed by `closeDbs`. `max` unset is the postgres.js default (10). */
export function pool(url: () => string, max?: () => number): Db {
  const db = lazy(() => drizzle(postgres(url(), { ...(max ? { max: max() } : {}), onnotice: () => {} })));
  pools.push(db);
  return db;
}

/**
 * A pool that its owner closes (the per-workspace pools, D35): `max` connections, each closed after
 * `idleSeconds` unused. Not closed by `closeDbs` itself; the owner registers with `onCloseDbs`.
 */
export function connect(url: string, max: number, idleSeconds = 600): { db: Db; end: () => Promise<void> } {
  const sql = postgres(url, { max, idle_timeout: idleSeconds, onnotice: () => {} });
  return { db: drizzle(sql), end: () => sql.end({ timeout: 30 }) };
}

const closers: (() => Promise<unknown>)[] = [];

/** Registers more pools for `closeDbs` to close. */
export function onCloseDbs(close: () => Promise<unknown>): void {
  closers.push(close);
}

/**
 * Control plane connection as `scout_app` (D35): tenancy and the platform-wide tables. Subject to row
 * level security: tenant rows are only visible with `app.tenant_id` set (`withControlTenant`).
 */
export const controlDb: Db = pool(() => config.databaseUrl, () => config.databasePoolMax);

/**
 * Control plane connection as `scout_admin` (bypasses row level security). For migrations,
 * platform-admin work and cross-tenant jobs only. Never use it on a request path that serves one
 * tenant.
 */
export const controlAdminDb: Db = pool(() => config.databaseAdminUrl);

/** @deprecated The control plane's `controlDb`; workspace work goes through `withTenant`. */
export const appDb: Db = controlDb;

/** @deprecated The control plane's `controlAdminDb`; one workspace's admin work goes through `withWorkspaceAdmin`. */
export const adminDb: Db = controlAdminDb;

/**
 * Runs `fn` in a savepoint of `tx` when one is given (a platform admin request's `adminDb`
 * transaction, so the request holds one connection), else in a new `adminDb` transaction.
 */
export function adminTransaction<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return tx ? tx.transaction(fn) : adminDb.transaction(fn);
}

/** Close every pool. Only needed by scripts and tests. Safe to call when never used. */
export async function closeDbs(): Promise<void> {
  await Promise.allSettled([
    ...pools.map((db) => (db as unknown as { $client: postgres.Sql }).$client.end()),
    ...closers.map((close) => close()),
  ]);
}
