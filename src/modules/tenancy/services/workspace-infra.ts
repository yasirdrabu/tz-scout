import { eq, sql } from 'drizzle-orm';
import type { WorkspaceInfo } from '@/platform/db/doors';
import { controlAdminDb } from '@/platform/db/client';
import type { Tx } from '@/platform/db/tenant';
import { workspaceInfra } from '../db/schema';

/** The only region until a second Postgres server exists (D35 decision 2). */
export const DEFAULT_REGION = 'us-1';

/** The registry row the database doors route by, or null. Registered with `registerWorkspaceLookup` (entry/compose.ts). */
export async function workspaceInfo(tenantId: string): Promise<WorkspaceInfo | null> {
  const [row] = await controlAdminDb
    .select({ status: workspaceInfra.status, database: workspaceInfra.database })
    .from(workspaceInfra)
    .where(eq(workspaceInfra.tenantId, tenantId));
  return row ?? null;
}

/** Registers a new tenant's workspace, in `tx` (its creation's control transaction): the shared database, active. */
export async function registerWorkspace(tx: Tx, tenantId: string): Promise<void> {
  await tx.insert(workspaceInfra).values({ tenantId, region: DEFAULT_REGION, database: sql`current_database()`, status: 'active' });
}
