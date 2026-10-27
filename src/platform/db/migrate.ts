import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { config } from '@/platform/config';

export const MODULE_ORDER = ['platform', 'tenancy', 'integrations', 'ai', 'offers', 'accounts'] as const;
export type ModuleName = (typeof MODULE_ORDER)[number];

const root = process.cwd();

export function migrationsFolder(m: ModuleName): string {
  return m === 'platform'
    ? path.join(root, 'src/platform/db/migrations')
    : path.join(root, 'src/modules', m === 'ai' ? 'ai-tasks' : m, 'db/migrations'); // schema ai, folder ai-tasks
}

export function bootstrapSqlPath(): string {
  return path.join(root, 'src/platform/db/bootstrap.sql');
}

/**
 * Runs bootstrap.sql (roles, schemas, grants) in the database `superuserUrl` points at.
 * Needs a superuser. Idempotent.
 */
export async function bootstrapDatabase(superuserUrl: string = config.databaseSuperuserUrl): Promise<void> {
  const sql = postgres(superuserUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(readFileSync(bootstrapSqlPath(), 'utf8'));
    // Passwords are quoted server-side with format(%L); never concatenated in JS.
    for (const [role, password] of [
      ['scout_app', config.appDbPassword],
      ['scout_admin', config.adminDbPassword],
    ] as const) {
      if (!password) continue;
      const [row] = await sql<{ q: string }[]>`select format('alter role %I password %L', ${role}::text, ${password}::text) as q`;
      await sql.unsafe(row!.q);
    }
  } finally {
    await sql.end();
  }
}

export type MigrateOptions = {
  adminUrl?: string;
  /** Override a module's migrations folder (tests). */
  folders?: Partial<Record<ModuleName, string>>;
};

/**
 * Applies each module's migrations in MODULE_ORDER as `scout_admin`. Assumes the
 * roles and schemas already exist (bootstrap.sql, run by a superuser).
 * Returns how many migrations were applied.
 */
export async function migrateAll(opts: MigrateOptions = {}): Promise<{ applied: number }> {
  const client = postgres(opts.adminUrl ?? config.databaseAdminUrl, { max: 1, onnotice: () => {} });
  const db = drizzle(client);
  let applied = 0;
  try {
    for (const m of MODULE_ORDER) {
      const folder = opts.folders?.[m] ?? migrationsFolder(m);
      const journal = path.join(folder, 'meta', '_journal.json');
      if (!existsSync(journal)) throw new Error(`Module "${m}" has no migration journal (expected ${journal}).`);
      const count = async () => {
        const r = await client.unsafe(
          `select count(*)::int as n from information_schema.tables where table_schema = '${m}' and table_name = '__migrations'`,
        );
        if (!r[0]?.n) return 0;
        const c = await client.unsafe(`select count(*)::int as n from "${m}"."__migrations"`);
        return (c[0]?.n as number) ?? 0;
      };
      const before = await count();
      await migrate(db, { migrationsFolder: folder, migrationsSchema: m, migrationsTable: '__migrations' });
      applied += (await count()) - before;
    }
  } finally {
    await client.end();
  }
  return { applied };
}
