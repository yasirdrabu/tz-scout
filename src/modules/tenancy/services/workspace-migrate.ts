import { and, eq, inArray, or } from 'drizzle-orm';
import { config } from '@/platform/config';
import { controlAdminDb } from '@/platform/db/client';
import { forgetWorkspace } from '@/platform/db/doors';
import { migrateWorkspaceDatabase } from '@/platform/db/migrate';
import { urlForDatabase } from '@/platform/db/workspace-pools';
import { errorText } from '@/platform/scrub-error';
import { workspaceInfra } from '../db/schema';

/** One database migrated, and the workspaces in it. */
export type WorkspaceMigration =
  | { database: string; tenantIds: string[]; applied: number }
  | { database: string; tenantIds: string[]; error: string };

/** The rows `scout migrate` looks after: active, or failed by an earlier `scout migrate` (step `migrate`). */
const migratable = or(eq(workspaceInfra.status, 'active'), and(eq(workspaceInfra.status, 'failed'), eq(workspaceInfra.failedStep, 'migrate')));

/**
 * `scout migrate` in `per_workspace` mode, after the control plane (D35): migrates every workspace
 * database once (several workspaces may share one, the shared database while they are moved out),
 * `concurrency` databases at a time, recording `schema_versions` on each of its workspaces. A database
 * that fails marks its workspaces `failed` (step `migrate`, with the error) and the others go on; ones
 * that failed to migrate before are tried again and are `active` once it migrates. A workspace being
 * provisioned, or failed while provisioning, is not touched (retrying provisioning migrates it), and
 * every update checks the status it expects, so a concurrent admin action is never overwritten.
 * `tenantId` narrows it to that workspace's database.
 */
export async function migrateWorkspaces(opts: { tenantId?: string; concurrency?: number } = {}): Promise<WorkspaceMigration[]> {
  const rows = await controlAdminDb
    .select({ tenantId: workspaceInfra.tenantId, database: workspaceInfra.database })
    .from(workspaceInfra)
    .where(and(migratable, opts.tenantId ? eq(workspaceInfra.tenantId, opts.tenantId) : undefined))
    .orderBy(workspaceInfra.database, workspaceInfra.tenantId);
  const byDatabase = new Map<string, string[]>();
  for (const r of rows) byDatabase.set(r.database, [...(byDatabase.get(r.database) ?? []), r.tenantId]);
  const due = [...byDatabase];
  const out: WorkspaceMigration[] = new Array(due.length);
  let next = 0;
  const run = async () => {
    while (next < due.length) {
      const i = next++;
      const [database, tenantIds] = due[i]!;
      const these = and(inArray(workspaceInfra.tenantId, tenantIds), migratable);
      try {
        const { applied, versions } = await migrateWorkspaceDatabase(urlForDatabase(config.databaseAdminUrl, database));
        await controlAdminDb
          .update(workspaceInfra)
          .set({ schemaVersions: versions, status: 'active', failedStep: null, failedError: null, updatedAt: new Date() })
          .where(these);
        out[i] = { database, tenantIds, applied };
      } catch (e) {
        const error = errorText(e).slice(0, 2000);
        await controlAdminDb
          .update(workspaceInfra)
          .set({ status: 'failed', failedStep: 'migrate', failedError: error, updatedAt: new Date() })
          .where(these);
        out[i] = { database, tenantIds, error };
      }
      for (const t of tenantIds) forgetWorkspace(t);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, due.length) }, run));
  return out;
}
