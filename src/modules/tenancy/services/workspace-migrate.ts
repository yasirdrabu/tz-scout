import { and, eq, inArray } from 'drizzle-orm';
import { config } from '@/platform/config';
import { controlAdminDb } from '@/platform/db/client';
import { forgetWorkspace } from '@/platform/db/doors';
import { migrateWorkspaceDatabase } from '@/platform/db/migrate';
import { urlForDatabase } from '@/platform/db/workspace-pools';
import { errorText } from '@/platform/scrub-error';
import { workspaceInfra } from '../db/schema';

export type WorkspaceMigration = { tenantId: string; database: string; applied: number } | { tenantId: string; database: string; error: string };

/**
 * `scout migrate` in `per_workspace` mode, after the control plane (D35): migrates every workspace
 * database, `concurrency` at a time, recording each one's `schema_versions`. A workspace that fails is
 * marked `failed` (step `migrate`, with the error) and the others go on; one that failed to migrate
 * before is tried again and is `active` once it migrates. `tenantId` narrows it to one workspace.
 */
export async function migrateWorkspaces(opts: { tenantId?: string; concurrency?: number } = {}): Promise<WorkspaceMigration[]> {
  const rows = await controlAdminDb
    .select()
    .from(workspaceInfra)
    .where(and(inArray(workspaceInfra.status, ['active', 'failed']), opts.tenantId ? eq(workspaceInfra.tenantId, opts.tenantId) : undefined))
    .orderBy(workspaceInfra.tenantId);
  // A workspace that failed to provision is not migrated here: retrying provisioning migrates it.
  const due = rows.filter((r) => r.status === 'active' || r.failedStep === 'migrate');
  const out: WorkspaceMigration[] = new Array(due.length);
  let next = 0;
  const run = async () => {
    while (next < due.length) {
      const i = next++;
      const r = due[i]!;
      try {
        const { applied, versions } = await migrateWorkspaceDatabase(urlForDatabase(config.databaseAdminUrl, r.database));
        await controlAdminDb
          .update(workspaceInfra)
          .set({ schemaVersions: versions, status: 'active', failedStep: null, failedError: null, updatedAt: new Date() })
          .where(eq(workspaceInfra.tenantId, r.tenantId));
        out[i] = { tenantId: r.tenantId, database: r.database, applied };
      } catch (e) {
        const error = errorText(e).slice(0, 2000);
        await controlAdminDb
          .update(workspaceInfra)
          .set({ status: 'failed', failedStep: 'migrate', failedError: error, updatedAt: new Date() })
          .where(eq(workspaceInfra.tenantId, r.tenantId));
        out[i] = { tenantId: r.tenantId, database: r.database, error };
      }
      forgetWorkspace(r.tenantId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, due.length) }, run));
  return out;
}
