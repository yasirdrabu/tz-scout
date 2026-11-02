import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { config } from '@/platform/config';
import { controlAdminDb } from '@/platform/db/client';
import { closeWorkspacePools, forgetWorkspace, moveLockKey } from '@/platform/db/doors';
import { createDatabase, databaseExists, migrateWorkspaceDatabase } from '@/platform/db/migrate';
import { copyTenantRows, countedByEvent, countTenantRows, deleteTenantRows, type TableCount } from '@/platform/db/move';
import { urlForDatabase } from '@/platform/db/workspace-pools';
import { log } from '@/platform/log';
import { workspaceInfra } from '../db/schema';
import { workspaceDatabaseName } from './workspace-infra';

/** Every instance caches the registry row for up to 60 seconds; waiting longer means all of them see `moving`. */
export const SPLIT_SETTLE_MS = 65_000;

export type SplitResult =
  | { tenantId: string; outcome: 'moved'; database: string; copied: TableCount[]; deleted: TableCount[] }
  | { tenantId: string; outcome: 'cleaned'; database: string; deleted: TableCount[] }
  | { tenantId: string; outcome: 'skipped'; reason: string };

const controlDatabase = () => decodeURIComponent(new URL(config.databaseAdminUrl).pathname.slice(1));
const adminUrl = (database: string) => urlForDatabase(config.databaseAdminUrl, database);

async function dropDatabase(name: string): Promise<void> {
  await closeWorkspacePools(name);
  const sql = postgres(config.databaseAdminUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`drop database if exists "${name.replace(/"/g, '""')}" with (force)`);
  } finally {
    await sql.end();
  }
}

/**
 * Before the shared database's rows of a moved workspace are deleted: its own database exists and holds,
 * table by table, at least as many of its rows as are left in the shared database (more once it has
 * been written to since the switch). Otherwise the rows are kept and the split refuses. The per-event
 * tables (`countedByEvent`) are left out: their rows for tenancy's events cannot be counted there.
 */
async function assertHoldsCopy(own: string, tenantId: string, left: TableCount[]): Promise<void> {
  if (!(await databaseExists(own))) {
    throw new Error(`Its registry row points at ${own}, which does not exist; its rows in the shared database are kept.`);
  }
  const there = new Map((await countTenantRows(adminUrl(own), tenantId)).map((c) => [c.table, c.rows]));
  const short = left.find((c) => !countedByEvent(c.table) && (there.get(c.table) ?? 0) < c.rows);
  if (short) {
    throw new Error(
      `${own} has fewer rows in ${short.table} (${there.get(short.table) ?? 0}) than the shared database still holds (${short.rows}); its rows in the shared database are kept.`,
    );
  }
}

/**
 * `scout tenant split <slug>` (D35 "Moving existing workspaces"): moves an active workspace out of the
 * shared database (the control plane's) into its own.
 * 1. The workspace is `moving`: requests get 503 with Retry-After, the worker puts its messages back.
 *    It waits `settleMs` (default 65 s) so every instance's cached registry row says so and work
 *    started before it has finished.
 * 2. Its database is made (from the template when free) and migrated.
 * 3. Its rows are copied, table by table in foreign key order, and the counts checked on both sides.
 * 4. The registry points at the new database and the workspace is `active` again.
 * 5. Its rows are deleted from the shared database.
 * A failure before 4 drops the new database and puts the workspace back to `active` where it was,
 * untouched (unless the registry already points at the new database: a switch whose acknowledgement
 * was lost keeps it). A failure in 5 leaves rows behind in the shared database, unused; running the
 * split again finishes it (`cleaned`), once the new database is checked to hold them. One split per
 * workspace at a time (a session advisory lock).
 */
export type SplitOptions = {
  settleMs?: number;
  /**
   * Cleaning up only (`scout tenant split <slug> --force-cleanup`): delete the rows left in the shared
   * database without checking the workspace's own database holds them (an operator checked it by hand).
   * Called with what is about to be deleted.
   */
  forceCleanup?: (left: TableCount[]) => void;
  /** Test hook: runs right after the switch commits. */
  afterSwitch?: () => void;
};

export async function splitWorkspace(tenantId: string, opts: SplitOptions = {}): Promise<SplitResult> {
  if (config.workspaceDatabases !== 'per_workspace') throw new Error('Moving a workspace needs SCOUT_WORKSPACE_DATABASES=per_workspace.');
  const lock = postgres(config.databaseAdminUrl, { max: 1, onnotice: () => {} });
  try {
    const [got] = await lock<{ ok: boolean }[]>`select pg_try_advisory_lock(hashtext(${`split:${tenantId}`})) as ok`;
    if (!got?.ok) return { tenantId, outcome: 'skipped', reason: 'another split of this workspace is running' };
    const [row] = await controlAdminDb.select().from(workspaceInfra).where(eq(workspaceInfra.tenantId, tenantId));
    if (!row) return { tenantId, outcome: 'skipped', reason: 'no workspace registry row' };
    const shared = controlDatabase();
    const own = workspaceDatabaseName(tenantId);

    if (row.database !== shared) {
      // Moved before, but its rows were not all deleted from the shared database: finish that. A
      // workspace made in its own database has none there, and is left alone.
      const left = row.database === own && row.status === 'active' ? await countTenantRows(adminUrl(shared), tenantId) : [];
      if (left.some((c) => c.rows > 0)) {
        if (opts.forceCleanup) opts.forceCleanup(left.filter((c) => c.rows > 0));
        else await assertHoldsCopy(own, tenantId, left);
        const deleted = await deleteTenantRows(adminUrl(shared), tenantId);
        return { tenantId, outcome: 'cleaned', database: own, deleted };
      }
      return { tenantId, outcome: 'skipped', reason: `it is already in its own database (${row.database})` };
    }
    // A split that stopped part way leaves it `moving` in the shared database: start again from there.
    const resuming = row.status === 'moving';
    if (row.status !== 'active' && !resuming) return { tenantId, outcome: 'skipped', reason: `it is ${row.status}` };

    const inShared = and(eq(workspaceInfra.tenantId, tenantId), eq(workspaceInfra.database, shared));
    if (!resuming) {
      const marked = await controlAdminDb
        .update(workspaceInfra)
        .set({ status: 'moving', updatedAt: new Date() })
        .where(and(inShared, eq(workspaceInfra.status, 'active')))
        .returning({ tenantId: workspaceInfra.tenantId });
      forgetWorkspace(tenantId);
      if (marked.length === 0) return { tenantId, outcome: 'skipped', reason: 'its status changed as the split started' };
    }
    await new Promise((r) => setTimeout(r, opts.settleMs ?? SPLIT_SETTLE_MS));
    // Work that began before `moving` reached every instance holds the move lock shared until it
    // commits: wait for it, then hold the lock until the switch, so nothing more is written there.
    await lock`select pg_advisory_lock(hashtext(${moveLockKey(tenantId)}))`;

    let copied: TableCount[];
    let versions: Awaited<ReturnType<typeof migrateWorkspaceDatabase>>['versions'];
    try {
      await dropDatabase(own); // whatever an earlier attempt left
      const template = (await databaseExists(config.workspaceTemplateDatabase)) ? config.workspaceTemplateDatabase : undefined;
      await createDatabase(own, template);
      ({ versions } = await migrateWorkspaceDatabase(adminUrl(own)));
      copied = await copyTenantRows(adminUrl(shared), adminUrl(own), tenantId);
      const switched = await controlAdminDb
        .update(workspaceInfra)
        .set({ database: own, status: 'active', schemaVersions: versions, updatedAt: new Date() })
        .where(and(inShared, eq(workspaceInfra.status, 'moving')))
        .returning({ tenantId: workspaceInfra.tenantId });
      // Something changed the row meanwhile (scout migrate marking it failed, say): it is still served
      // from the shared database, so nothing there may be deleted.
      if (switched.length === 0) throw new Error('Its registry row changed during the move; nothing was switched.');
      opts.afterSwitch?.();
      forgetWorkspace(tenantId);
    } catch (e) {
      // The switch may have committed with its acknowledgement lost: then the workspace is served from
      // its own database, which must stay. Only a row still in the shared database is undone; when the
      // row cannot be read, nothing is dropped.
      const now = await controlAdminDb
        .select({ database: workspaceInfra.database })
        .from(workspaceInfra)
        .where(eq(workspaceInfra.tenantId, tenantId))
        .then(([r]) => r ?? null)
        .catch(() => undefined);
      if (now === undefined) {
        log.error({ tenantId, err: e }, 'split: could not read the registry row; nothing was undone; run the split again');
      } else if (now?.database === shared) {
        await dropDatabase(own).catch(() => undefined);
        await controlAdminDb.update(workspaceInfra).set({ status: 'active', updatedAt: new Date() }).where(and(inShared, eq(workspaceInfra.status, 'moving')));
      } else {
        log.error({ tenantId, err: e }, 'split: the switch went through but reported an error; its database is kept, run the split again to finish');
      }
      forgetWorkspace(tenantId);
      throw e;
    } finally {
      await lock`select pg_advisory_unlock(hashtext(${moveLockKey(tenantId)}))`;
    }
    let deleted: TableCount[] = [];
    try {
      deleted = await deleteTenantRows(adminUrl(shared), tenantId);
    } catch (e) {
      log.error({ tenantId, err: e }, 'split: moved, but its rows are still in the shared database; run the split again to delete them');
    }
    return { tenantId, outcome: 'moved', database: own, copied, deleted };
  } finally {
    await lock.end({ timeout: 5 });
  }
}
