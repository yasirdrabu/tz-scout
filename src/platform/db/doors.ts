import { sql } from 'drizzle-orm';
import { PLATFORM_TENANT } from '../audit';
import { config, type Config } from '../config';
import { ScoutError } from '../errors';
import { log } from '../log';
import { adminTransaction, connect, controlAdminDb, controlDb, onCloseDbs, pool, type Db } from './client';
import { urlForDatabase, WorkspacePools } from './workspace-pools';
import type { Tx } from './tenant';

/**
 * The doors to the databases (D35). The control plane holds tenancy and the platform-wide tables;
 * each workspace's data is reached through `workspaceDb(tenantId)`. With
 * `SCOUT_WORKSPACE_DATABASES=shared` (the default) every workspace is the control plane's database,
 * on pools of their own so a request holding a workspace connection never waits for its own pool to
 * open a control-plane transaction.
 */

/** The workspace registry's row for a tenant (`tenancy.workspace_infra`). */
export type WorkspaceInfo = { status: string; database: string };

/** Reads a tenant's registry row; null when it has none. Registered by tenancy (inverted dependency). */
export type WorkspaceLookup = (tenantId: string) => Promise<WorkspaceInfo | null>;

/** Every tenant's registry row, for cross-workspace work in `per_workspace` mode. Registered by tenancy. */
export type WorkspaceListing = () => Promise<Array<WorkspaceInfo & { tenantId: string }>>;

let lookup: WorkspaceLookup | undefined;
let listing: WorkspaceListing | undefined;
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; info: WorkspaceInfo | null }>();
/** The registry list, cached briefly: the relay and scheduler read it every turn. */
const LIST_CACHE_MS = 5_000;
let listed: { at: number; rows: Array<WorkspaceInfo & { tenantId: string }> } | undefined;

export function registerWorkspaceLookup(fn: WorkspaceLookup, list?: WorkspaceListing): void {
  lookup = fn;
  listing = list;
  cache.clear();
  listed = undefined;
}

/**
 * Drops this instance's cached registry row for a tenant, or every one. Other instances catch up within
 * 60 seconds. Call it after every commit that writes a tenant's `workspace_infra` row (creation today;
 * provisioning, suspend, move, delete with Task 5 and later), so this instance never routes on the old one.
 */
export function forgetWorkspace(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
  listed = undefined;
}

async function infoFor(tenantId: string, fresh = false): Promise<WorkspaceInfo | null> {
  if (!lookup) return null;
  const hit = cache.get(tenantId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  const info = await lookup(tenantId);
  if (cache.size >= 10_000) cache.clear();
  cache.set(tenantId, { at: Date.now(), info });
  return info;
}

const sharedWorkspace = {
  app: pool(() => config.databaseUrl, () => config.databasePoolMax),
  admin: pool(() => config.databaseAdminUrl),
};

// `per_workspace` mode: a pool per workspace database (see WorkspacePools), closed after 10 minutes idle.
const IDLE_MS = 600_000;
const workspacePools = new WorkspacePools(
  (database, role, max) => connect(urlForDatabase(role === 'app' ? config.databaseUrl : config.databaseAdminUrl, database), max, IDLE_MS / 1000),
  () => ({ max: config.workspacePoolMax, cap: config.workspacePoolCap, idleMs: IDLE_MS }),
  Date.now,
  (open, allowed) => log.warn({ open, allowed }, 'workspace pools: over SCOUT_WORKSPACE_POOL_CAP, every pool is in use'),
);
// The relay's own budget (SCOUT_RELAY_POOL_CAP): one admin connection per workspace database it polls,
// so polling every workspace does not churn the request and worker pools above.
const relayPools = new WorkspacePools(
  (database) => connect(urlForDatabase(config.databaseAdminUrl, database), 1, IDLE_MS / 1000),
  () => ({ max: 0, cap: config.relayPoolCap, idleMs: IDLE_MS }),
  Date.now,
  (open, allowed) => log.warn({ open, allowed }, 'relay pools: over SCOUT_RELAY_POOL_CAP, every pool is in use'),
);
let idleTimer: ReturnType<typeof setInterval> | undefined;
onCloseDbs(async () => {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = undefined;
  await Promise.all([workspacePools.closeAll(), relayPools.closeAll()]);
});

function startIdleTimer(): void {
  if (idleTimer) return;
  idleTimer = setInterval(() => void Promise.all([workspacePools.closeIdle(), relayPools.closeIdle()]), 60_000);
  idleTimer.unref?.();
}

function poolsOf(database: string): { app: Db; admin: Db } {
  startIdleTimer();
  return workspacePools.get(database);
}

/** Closes one workspace database's pools in this process (before it is dropped or moved), or every one. */
export function closeWorkspacePools(database?: string): Promise<void> {
  return workspacePools.closeAll(database);
}

/** Workspace databases with open pools in this process, least recently used first. For tests and health. */
export function openWorkspacePools(): string[] {
  return workspacePools.openDatabases();
}

const unavailable = () =>
  new ScoutError({ slug: 'workspace-unavailable', status: 503, title: 'This workspace is not available right now.' });

/**
 * Where a tenant's workspace is, from its registry row: 503 `workspace-unavailable` when the row says
 * it is not `active` (`suspended` included: every request is refused). With no row, `shared` mode
 * uses the shared database (rows the tests write by hand); `per_workspace` mode has nowhere to go, so
 * that is an error (tenant creation writes the row in its own transaction, and migration 0006 backfilled
 * every older tenant).
 */
export function workspaceRoute(
  tenantId: string,
  info: WorkspaceInfo | null,
  mode: Config['workspaceDatabases'],
  opening = false,
): { shared: true } | { database: string } {
  if (info && info.status !== 'active' && !(opening && info.status === 'provisioning')) throw unavailable();
  if (mode === 'shared') return { shared: true };
  if (!info) throw new Error(`Tenant ${tenantId} has no workspace registry row (tenancy.workspace_infra).`);
  return { database: info.database };
}

/** `provisioning`: open a workspace that is still `provisioning`, to seed it. Only provisioning does. */
export type WorkspaceOpen = { provisioning?: boolean };

/**
 * The connections for one workspace: `app` (row level security applies) and `admin` (bypasses it).
 * `t_platform` is the control plane; every other tenant goes where `workspaceRoute` says.
 */
export async function workspaceDb(tenantId: string, opts: WorkspaceOpen = {}): Promise<{ app: Db; admin: Db }> {
  if (tenantId === PLATFORM_TENANT) return { app: controlDb, admin: controlAdminDb };
  // Provisioning reads the row fresh: a cached one may still say `failed` from before a retry.
  const route = workspaceRoute(tenantId, await infoFor(tenantId, opts.provisioning), config.workspaceDatabases, opts.provisioning);
  return 'database' in route ? poolsOf(route.database) : sharedWorkspace;
}

/**
 * Every workspace database, for cross-workspace jobs. `shared` mode: one entry standing for all tenants.
 * `per_workspace` mode: each database an `active` workspace is in, once (`tenantId` '*' for one that
 * holds several: the shared database, while workspaces are moved out of it). Its `admin` pool opens when
 * first used, so a loop over them holds few pools at a time (the LRU cap closes the ones done with).
 */
export async function listWorkspaceDatabases(): Promise<Array<{ tenantId: string; database: string; admin: Db }>> {
  if (config.workspaceDatabases === 'shared') return [{ tenantId: '*', database: controlDatabase(), admin: sharedWorkspace.admin }];
  if (!listing) throw new Error('No workspace listing is registered (entry/compose.ts).');
  if (!listed || Date.now() - listed.at >= LIST_CACHE_MS) listed = { at: Date.now(), rows: await listing() };
  const byDatabase = new Map<string, string>();
  for (const r of listed.rows) {
    if (r.status !== 'active') continue;
    byDatabase.set(r.database, byDatabase.has(r.database) ? '*' : r.tenantId);
  }
  return [...byDatabase].map(([database, tenantId]) => ({
    tenantId,
    database,
    get admin() {
      return poolsOf(database).admin;
    },
  }));
}

/** The control plane's database name (from `DATABASE_ADMIN_URL`). */
function controlDatabase(): string {
  return decodeURIComponent(new URL(config.databaseAdminUrl).pathname.slice(1));
}

/** How many workspace databases cross-workspace admin reads work on at once. */
export const WORKSPACE_READ_PARALLELISM = 4;

/** `fn` over every workspace database (`listWorkspaceDatabases`), `limit` at a time; results in list order. */
export async function mapWorkspaces<T>(fn: (w: { tenantId: string; admin: Db }) => Promise<T>, limit = WORKSPACE_READ_PARALLELISM): Promise<T[]> {
  return mapLimited(await listWorkspaceDatabases(), fn, limit);
}

/** `fn` over every database with an outbox (`platformDatabases`), `limit` at a time; results in list order. */
export async function mapPlatformDatabases<T>(fn: (db: PlatformDatabase) => Promise<T>, limit = WORKSPACE_READ_PARALLELISM): Promise<T[]> {
  return mapLimited(await platformDatabases(), fn, limit);
}

async function mapLimited<I, T>(all: I[], fn: (item: I) => Promise<T>, limit: number): Promise<T[]> {
  const out: T[] = new Array(all.length);
  let next = 0;
  const run = async () => {
    while (next < all.length) {
      const i = next++;
      out[i] = await fn(all[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, all.length) }, run));
  return out;
}

/** A database with its own outbox, schedules and dead jobs, as `scout_admin`. */
export type PlatformDatabase = { name: string; admin: Db; control: boolean };

/**
 * Every database with an outbox, for the relay, the scheduler and dead jobs: the control plane
 * (tenancy events, `t_platform` jobs), then each workspace database that is not the control plane's.
 * `shared` mode: the control plane alone, since every workspace lives in it. `relay`: on the relay's own
 * connections (`SCOUT_RELAY_POOL_CAP`), not the workspace pools.
 */
export async function platformDatabases(opts: { relay?: boolean } = {}): Promise<PlatformDatabase[]> {
  const control: PlatformDatabase = { name: 'control', admin: controlAdminDb, control: true };
  if (config.workspaceDatabases === 'shared') return [control];
  // A workspace still in the control plane's database is read as the control plane.
  const workspaces = (await listWorkspaceDatabases()).filter((w) => w.database !== controlDatabase());
  return [
    control,
    ...workspaces.map((w) => ({
      name: w.database,
      control: false,
      get admin() {
        if (!opts.relay) return w.admin;
        startIdleTimer();
        return relayPools.admin(w.database);
      },
    })),
  ];
}

/**
 * Runs `fn` in each database (`platformDatabases`) in turn, as `scout_admin`, until it finds what it
 * looks for (returns `{ value }`, not undefined): for a platform admin acting on a row by id (a
 * schedule, a dead job). The control plane's turn runs in a savepoint of `controlTx` when given.
 */
export async function inDatabaseHolding<T>(
  controlTx: Tx | undefined,
  fn: (tx: Tx, db: PlatformDatabase) => Promise<{ value: T } | undefined>,
): Promise<{ value: T } | undefined> {
  for (const db of await platformDatabases()) {
    const found = await (db.control ? adminTransaction(controlTx, (tx) => fn(tx, db)) : db.admin.transaction((tx) => fn(tx, db)));
    if (found) return found;
  }
  return undefined;
}

// Control-plane transactions, with the tenant `app.tenant_id` is set to (null for the admin role, which sees every tenant).
const controlTxs = new WeakMap<Tx, { tenantId: string | null }>();

/** True when `tx` is a control-plane transaction (from `withControl`, `withControlAdmin` or `withControlTenant`). */
export function isControlTx(tx: Tx): boolean {
  return controlTxs.has(tx);
}

/** True when `tx` is a control-plane transaction that sees `tenantId`'s rows: the admin role's, or one set to that tenant. */
export function controlTxServes(tx: Tx, tenantId: string): boolean {
  const mark = controlTxs.get(tx);
  return mark !== undefined && (mark.tenantId === null || mark.tenantId === tenantId);
}

/** Runs `fn` in a control-plane transaction as `scout_app` (row level security applies; no tenant set). */
export function withControl<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return controlDb.transaction((tx) => {
    controlTxs.set(tx, { tenantId: '' });
    return fn(tx);
  });
}

/** Runs `fn` in a control-plane transaction as `scout_app` with `app.tenant_id` set: a tenant's tenancy rows. */
export function withControlTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return controlDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    controlTxs.set(tx, { tenantId });
    return fn(tx);
  });
}

/** Runs `fn` in a control-plane transaction as `scout_admin` (bypasses row level security). Platform work only. */
export function withControlAdmin<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return controlAdminDb.transaction((tx) => {
    controlTxs.set(tx, { tenantId: null });
    return fn(tx);
  });
}

let wrapWorkspaceTx: ((tx: Tx) => Tx) | undefined;

/** Test hook: wraps every workspace transaction (the tenancy guard test refuses tenancy SQL through it). */
export function setWorkspaceTxWrapper(wrap: ((tx: Tx) => Tx) | undefined): void {
  wrapWorkspaceTx = wrap;
}

/** The transaction workspace code gets: `tx`, or the test hook's wrapper of it. */
export function workspaceTx(tx: Tx): Tx {
  return wrapWorkspaceTx ? wrapWorkspaceTx(tx) : tx;
}

/** Runs `fn` in a transaction on one workspace's database as `scout_admin`, for work across row level security there. */
export async function withWorkspaceAdmin<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (tenantId === PLATFORM_TENANT) return withControlAdmin(fn);
  const { admin } = await workspaceDb(tenantId);
  return admin.transaction((tx) => fn(workspaceTx(tx)));
}
