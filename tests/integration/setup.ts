import { createDatabase, migrateAll, migrateControlPlane, migrateWorkspaceDatabase } from '@/platform/db/migrate';
import { urlForDatabase } from '@/platform/db/workspace-pools';
import { POSTGRES_DOWN_MESSAGE, dropScratchDatabase, freshDatabase, superuserSql } from './helpers/db';

/**
 * Creates the run's throwaway control plane database `scout_test_<pid>`, bootstraps and migrates it,
 * and points DATABASE_URL / DATABASE_ADMIN_URL at it for the test workers. In `per_workspace` mode
 * (the default, D35) the control plane gets only its own modules, and the run's template workspace
 * database `scout_test_<pid>_template` is made and migrated: each test file copies it
 * (workspace-per-file.ts). `SCOUT_WORKSPACE_DATABASES=shared` runs the suite on one database as before.
 * Dropped at teardown.
 */
export default async function setup() {
  const probe = superuserSql();
  try {
    await probe`select 1`;
  } catch (e) {
    throw new Error(`${POSTGRES_DOWN_MESSAGE} (${(e as Error).message})`);
  } finally {
    await probe.end({ timeout: 1 });
  }

  const db = await freshDatabase(`scout_test_${process.pid}`);
  process.env.DATABASE_URL = db.appUrl;
  process.env.DATABASE_ADMIN_URL = db.adminUrl;
  if (process.env.SCOUT_WORKSPACE_DATABASES === 'shared') {
    await migrateAll({ adminUrl: db.adminUrl });
    return async () => {
      await db.drop();
    };
  }

  const template = `scout_test_${process.pid}_template`;
  process.env.SCOUT_WORKSPACE_TEMPLATE_DATABASE = template;
  // A test file's tenants share one workspace database (workspace-per-file.ts), so its pool stands for
  // many workspaces at once, and test fixtures nest transactions deeper than request code does.
  process.env.SCOUT_WORKSPACE_POOL_MAX ??= '10';
  process.env.SCOUT_WORKSPACE_POOL_CAP ??= '200';
  await migrateControlPlane({ adminUrl: db.adminUrl });
  await createDatabase(template, undefined, db.adminUrl);
  await migrateWorkspaceDatabase(urlForDatabase(db.adminUrl, template));

  return async () => {
    await dropScratchDatabase(template);
    await db.drop();
  };
}
