import { sql } from 'drizzle-orm';
import { PLATFORM_TENANT } from '../audit';
import type { controlDb } from './client';
import { withControlTenant, workspaceDb, workspaceTx, type WorkspaceOpen } from './doors';

export type Tx = Parameters<Parameters<typeof controlDb.transaction>[0]>[0];

/**
 * Runs `fn` in a transaction on the tenant's workspace database (`workspaceDb`) with the tenant set
 * for row level security. The setting is transaction-local, so it cannot leak to another request on
 * the same pooled connection. `t_platform` is the control plane.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, open: WorkspaceOpen = {}): Promise<T> {
  if (tenantId === PLATFORM_TENANT) return withControlTenant(tenantId, fn);
  const { app } = await workspaceDb(tenantId, open);
  return app.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(workspaceTx(tx));
  });
}
