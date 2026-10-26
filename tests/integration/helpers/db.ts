import postgres from 'postgres';
import { config } from '@/platform/config';

export const POSTGRES_DOWN_MESSAGE =
  'Postgres is not running. Start it with `npm run services:local` or docker compose.';

/** Same server and credentials as `url`, different database. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function superuserSql(database = 'postgres') {
  return postgres(withDatabase(config.databaseSuperuserUrl, database), { max: 1, onnotice: () => {} });
}

/** Creates an empty database owned by the current superuser; bootstrap hands it to scout_admin. */
export async function createScratchDatabase(name: string): Promise<void> {
  const sql = superuserSql();
  try {
    await sql.unsafe(`drop database if exists "${name}" with (force)`);
    await sql.unsafe(`create database "${name}"`);
  } finally {
    await sql.end();
  }
}

export async function dropScratchDatabase(name: string): Promise<void> {
  const sql = superuserSql();
  try {
    await sql.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await sql.end();
  }
}

/** A fresh, bootstrapped, unmigrated database. Returns its admin url and a cleanup function. */
export async function freshDatabase(
  name: string,
): Promise<{ name: string; adminUrl: string; appUrl: string; drop: () => Promise<void> }> {
  const { bootstrapDatabase } = await import('@/platform/db/migrate');
  await createScratchDatabase(name);
  await bootstrapDatabase(withDatabase(config.databaseSuperuserUrl, name));
  return {
    name,
    adminUrl: withDatabase(config.databaseAdminUrl, name),
    appUrl: withDatabase(config.databaseUrl, name),
    drop: () => dropScratchDatabase(name),
  };
}
