import { eq, sql } from 'drizzle-orm';
import { config } from '@/platform/config';
import type { WorkspaceInfo } from '@/platform/db/doors';
import { pool } from '@/platform/db/client';
import type { Tx } from '@/platform/db/tenant';
import { workspaceInfra } from '../db/schema';

/** The only region until a second Postgres server exists (D35 decision 2). */
export const DEFAULT_REGION = 'us-1';

/** A workspace's own database (`per_workspace` mode): `scout_` and the tenant id lower-cased, `scout_t_01h…`. */
export function workspaceDatabaseName(tenantId: string): string {
  return `scout_${tenantId.toLowerCase()}`;
}

/**
 * The registry's own small pool on the control plane (as `scout_admin`). The doors look the registry up
 * from inside other work, such as a platform admin request that holds a control plane admin
 * transaction: on the admin pool, enough of those at once would hold every connection while each
 * waits for one more. Each lookup is a single statement, so this pool always frees up.
 */
const registryDb = pool(() => config.databaseAdminUrl, () => 2);

/** The registry row the database doors route by, or null. Registered with `registerWorkspaceLookup` (entry/compose.ts). */
export async function workspaceInfo(tenantId: string): Promise<WorkspaceInfo | null> {
  const [row] = await registryDb
    .select({ status: workspaceInfra.status, database: workspaceInfra.database })
    .from(workspaceInfra)
    .where(eq(workspaceInfra.tenantId, tenantId));
  return row ?? null;
}

/** Every registry row, for the doors' list of workspace databases. */
export async function workspaceList(): Promise<Array<WorkspaceInfo & { tenantId: string }>> {
  return registryDb
    .select({ tenantId: workspaceInfra.tenantId, status: workspaceInfra.status, database: workspaceInfra.database })
    .from(workspaceInfra)
    .orderBy(workspaceInfra.tenantId);
}

/**
 * Registers a new tenant's workspace, in `tx` (its creation's control transaction). `shared` mode: this
 * database, active. `per_workspace` mode: its own database, `provisioning` until the provisioning job
 * has made it. Returns the status written.
 */
export async function registerWorkspace(tx: Tx, tenantId: string): Promise<'active' | 'provisioning'> {
  const own = config.workspaceDatabases === 'per_workspace';
  const placed = own ? placement?.(tenantId) : undefined;
  const status = own && !placed ? 'provisioning' : 'active';
  await tx.insert(workspaceInfra).values({
    tenantId,
    region: DEFAULT_REGION,
    database: placed?.database ?? (own ? workspaceDatabaseName(tenantId) : sql`current_database()`),
    status,
  });
  return status;
}

let placement: ((tenantId: string) => { database: string } | undefined) | undefined;

/**
 * Test hook (`per_workspace` mode): new workspaces go into an existing, migrated database and are open
 * at once, with no provisioning (the integration tests' database per test file). Pass undefined to stop.
 */
export function placeNewWorkspaces(fn: ((tenantId: string) => { database: string } | undefined) | undefined): void {
  placement = fn;
}
