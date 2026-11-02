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

/** A Db that stands for whatever `target` returns at each use. */
function delegate(target: () => Db): Db {
  return new Proxy({} as Db, {
    get: (_t, prop) => {
      const db = target();
      const value = Reflect.get(db, prop, db);
      return typeof value === 'function' && prop !== '$client' ? value.bind(db) : value;
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
export function connect(url: string, max: number, idleSeconds = 600): { db: Db; end: () => Promise<void>; inUse: () => number } {
  const sql = postgres(url, { max, idle_timeout: idleSeconds, onnotice: () => {} });
  let inUse = 0;
  // Counts what is running on the pool: a transaction (begin) from start to end, a query from when it
  // is made until it settles. Drizzle runs every statement through these two. A query made and never
  // awaited stays counted, which only keeps its pool open.
  const counted = (run: () => PromiseLike<unknown>) => {
    let done = false;
    const release = () => {
      if (!done) {
        done = true;
        inUse--;
      }
    };
    return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(run()).finally(release).then(onFulfilled, onRejected);
  };
  const client = new Proxy(sql, {
    get(target, prop) {
      if (prop === 'begin') {
        return (...args: unknown[]) => {
          inUse++;
          return (target.begin as (...a: unknown[]) => Promise<unknown>)(...args).finally(() => inUse--);
        };
      }
      if (prop === 'unsafe') {
        return (...args: unknown[]) => {
          const query = (target.unsafe as (...a: unknown[]) => PromiseLike<unknown> & { values: () => unknown })(...args);
          inUse++;
          const then = counted(() => query);
          return new Proxy(query, {
            get(q, p) {
              if (p === 'then') return then;
              if (p === 'values') {
                return () => {
                  q.values();
                  return { then };
                };
              }
              const v = Reflect.get(q, p, q);
              return typeof v === 'function' ? v.bind(q) : v;
            },
          });
        };
      }
      return Reflect.get(target, prop, target);
    },
  });
  return { db: drizzle(client), end: () => sql.end({ timeout: 30 }), inUse: () => inUse };
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
export const appDb: Db = delegate(() => testDbs.app ?? controlDb);

/** @deprecated The control plane's `controlAdminDb`; one workspace's admin work goes through `withWorkspaceAdmin`. */
export const adminDb: Db = delegate(() => testDbs.admin ?? controlAdminDb);

// What the deprecated aliases stand for. Nothing in src uses them any more: they are the tests' way
// to reach "the database", which with a database per workspace is more than one (tests route them).
const testDbs: { app?: Db; admin?: Db } = {};

/** Test hook: what `appDb` and `adminDb` run on (the integration tests' router across databases). */
export function setTestDbs(dbs: { app?: Db; admin?: Db }): void {
  testDbs.app = dbs.app;
  testDbs.admin = dbs.admin;
}

/**
 * Runs `fn` in a savepoint of `tx` when one is given (a platform admin request's control plane
 * transaction, so the request holds one connection), else in a new control plane admin transaction.
 */
export function adminTransaction<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return tx ? tx.transaction(fn) : controlAdminDb.transaction(fn);
}

/** Close every pool. Only needed by scripts and tests. Safe to call when never used. */
export async function closeDbs(): Promise<void> {
  await Promise.allSettled([
    ...pools.map((db) => (db as unknown as { $client: postgres.Sql }).$client.end()),
    ...closers.map((close) => close()),
  ]);
}
