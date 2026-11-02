import { sql } from 'drizzle-orm';
import { PLATFORM_TENANT } from '../audit';
import { config, type Config } from '../config';
import { ScoutError } from '../errors';
import { adminTransaction, controlAdminDb, controlDb, pool, type Db } from './client';
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

let lookup: WorkspaceLookup | undefined;
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; info: WorkspaceInfo | null }>();

export function registerWorkspaceLookup(fn: WorkspaceLookup): void {
  lookup = fn;
  cache.clear();
}

/**
 * Drops this instance's cached registry row for a tenant, or every one. Other instances catch up within
 * 60 seconds. Call it after every commit that writes a tenant's `workspace_infra` row (creation today;
 * provisioning, suspend, move, delete with Task 5 and later), so this instance never routes on the old one.
 */
export function forgetWorkspace(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

async function infoFor(tenantId: string): Promise<WorkspaceInfo | null> {
  if (!lookup) return null;
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  const info = await lookup(tenantId);
  if (cache.size >= 10_000) cache.clear();
  cache.set(tenantId, { at: Date.now(), info });
  return info;
}

const sharedWorkspace = {
  app: pool(() => config.databaseUrl, () => config.databasePoolMax),
  admin: pool(() => config.databaseAdminUrl),
};

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
): { shared: true } | { database: string } {
  if (info && info.status !== 'active') throw unavailable();
  if (mode === 'shared') return { shared: true };
  if (!info) throw new Error(`Tenant ${tenantId} has no workspace registry row (tenancy.workspace_infra).`);
  return { database: info.database };
}

/**
 * The connections for one workspace: `app` (row level security applies) and `admin` (bypasses it).
 * `t_platform` is the control plane; every other tenant goes where `workspaceRoute` says.
 */
export async function workspaceDb(tenantId: string): Promise<{ app: Db; admin: Db }> {
  if (tenantId === PLATFORM_TENANT) return { app: controlDb, admin: controlAdminDb };
  const route = workspaceRoute(tenantId, await infoFor(tenantId), config.workspaceDatabases);
  if ('database' in route) throw new Error('SCOUT_WORKSPACE_DATABASES=per_workspace is not available yet.');
  return sharedWorkspace;
}

/** Every workspace database, for cross-workspace jobs. `shared` mode: one entry standing for all tenants. */
export async function listWorkspaceDatabases(): Promise<Array<{ tenantId: string; admin: Db }>> {
  return [{ tenantId: '*', admin: sharedWorkspace.admin }];
}

/** A database with its own outbox, schedules and dead jobs, as `scout_admin`. */
export type PlatformDatabase = { name: string; admin: Db; control: boolean };

/**
 * Every database with an outbox, for the relay, the scheduler and dead jobs: the control plane
 * (tenancy events, `t_platform` jobs), then each workspace database that is not the control plane's.
 * `shared` mode: the control plane alone, since every workspace lives in it.
 */
export async function platformDatabases(): Promise<PlatformDatabase[]> {
  const control: PlatformDatabase = { name: 'control', admin: controlAdminDb, control: true };
  if (config.workspaceDatabases === 'shared') return [control];
  const workspaces = await listWorkspaceDatabases();
  return [control, ...workspaces.map((w) => ({ name: w.tenantId, admin: w.admin, control: false }))];
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
