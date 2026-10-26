// Run with tsx (it resolves the `@/` alias): `tsx tests/e2e/prepare-db.ts [create|drop]`.
import { E2E_DB } from './env';

async function main() {
  const { freshDatabase, dropScratchDatabase, POSTGRES_DOWN_MESSAGE, superuserSql } = await import(
    '../integration/helpers/db'
  );
  if (process.argv[2] === 'drop') {
    await dropScratchDatabase(E2E_DB);
    return;
  }
  const probe = superuserSql();
  try {
    await probe`select 1`;
  } catch (e) {
    throw new Error(`${POSTGRES_DOWN_MESSAGE} (${(e as Error).message})`);
  } finally {
    await probe.end({ timeout: 1 });
  }
  const db = await freshDatabase(E2E_DB);
  const { migrateAll } = await import('@/platform/db/migrate');
  await migrateAll({ adminUrl: db.adminUrl });

  const { seed } = await import('@/entry/seed');
  await seed();
  const { closeDbs } = await import('@/platform/db/client');
  await closeDbs();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
