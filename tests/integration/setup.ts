import { migrateAll } from '@/platform/db/migrate';
import { POSTGRES_DOWN_MESSAGE, freshDatabase, superuserSql } from './helpers/db';

/**
 * Creates a throwaway database `scout_test_<pid>`, bootstraps and migrates it, and points
 * DATABASE_URL / DATABASE_ADMIN_URL at it for the test workers. Dropped at teardown.
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
  await migrateAll({ adminUrl: db.adminUrl });

  return async () => {
    await db.drop();
  };
}
