import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { config } from '@/platform/config';

export const MODULE_ORDER = ['platform', 'tenancy', 'integrations', 'ai', 'offers', 'accounts', 'crm', 'intake', 'scoring', 'routing', 'playbooks', 'enrichment', 'analytics'] as const;
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

/** The modules whose schemas the control plane holds in `per_workspace` mode (D35). */
export const CONTROL_MODULES: readonly ModuleName[] = ['platform', 'tenancy'];
/** The modules whose schemas each workspace database holds: every one but tenancy. */
export const WORKSPACE_MODULES: readonly ModuleName[] = MODULE_ORDER.filter((m) => m !== 'tenancy');

/** Migrations applied per module, e.g. `{ platform: 9, intake: 14 }`: what `workspace_infra.schema_versions` records. */
export type SchemaVersions = Partial<Record<ModuleName, number>>;

/** The migrations the code has per module, to tell when a database trails it ("Behind"). */
export function codeSchemaVersions(modules: readonly ModuleName[] = MODULE_ORDER): SchemaVersions {
  const out: SchemaVersions = {};
  for (const m of modules) {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder(m), 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] };
    out[m] = journal.entries.length;
  }
  return out;
}

/** Applies `modules`' migrations in MODULE_ORDER as `scout_admin` on the database `adminUrl` names. */
async function migrateModules(
  adminUrl: string,
  modules: readonly ModuleName[],
  folders: MigrateOptions['folders'] = {},
): Promise<{ applied: number; versions: SchemaVersions }> {
  const client = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const db = drizzle(client);
  let applied = 0;
  const versions: SchemaVersions = {};
  try {
    // One migrator per database at a time (two workspaces in one database, two migrate commands).
    await client.unsafe("select pg_advisory_lock(hashtext('scout_migrate'))");
    for (const m of MODULE_ORDER.filter((x) => modules.includes(x))) {
      const folder = folders[m] ?? migrationsFolder(m);
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
      versions[m] = await count();
      applied += versions[m]! - before;
    }
  } finally {
    await client.end();
  }
  return { applied, versions };
}

/**
 * Applies each module's migrations in MODULE_ORDER as `scout_admin`. Assumes the
 * roles and schemas already exist (bootstrap.sql, run by a superuser).
 * Returns how many migrations were applied. One database holding everything (`shared` mode).
 */
export async function migrateAll(opts: MigrateOptions = {}): Promise<{ applied: number }> {
  const { applied } = await migrateModules(opts.adminUrl ?? config.databaseAdminUrl, MODULE_ORDER, opts.folders);
  return { applied };
}

/** `per_workspace` mode: the control plane's own modules (platform, tenancy) on `DATABASE_ADMIN_URL`. */
export async function migrateControlPlane(opts: MigrateOptions = {}): Promise<{ applied: number; versions: SchemaVersions }> {
  return migrateModules(opts.adminUrl ?? config.databaseAdminUrl, CONTROL_MODULES, opts.folders);
}

export function workspaceBootstrapSqlPath(): string {
  return path.join(root, 'src/platform/db/bootstrap-workspace.sql');
}

/**
 * Bootstraps (bootstrap-workspace.sql, as `scout_admin`, its owner) and migrates one workspace database:
 * every module but tenancy. Idempotent. Returns what it applied and the versions now there.
 */
export async function migrateWorkspaceDatabase(adminUrl: string): Promise<{ applied: number; versions: SchemaVersions }> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(readFileSync(workspaceBootstrapSqlPath(), 'utf8'));
  } finally {
    await sql.end();
  }
  return migrateModules(adminUrl, WORKSPACE_MODULES);
}

/**
 * Creates database `name` as `scout_admin` (so it owns it) when it does not exist yet, copied from
 * `template` when given; when the template cannot be copied (someone is connected to it, 55006) it is
 * created empty, for the caller to migrate. Returns false when it was already there. Runs outside any
 * transaction (as CREATE DATABASE must) on its own connection to the control plane.
 */
export async function createDatabase(name: string, template?: string, adminUrl: string = config.databaseAdminUrl): Promise<boolean> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const [found] = await sql`select 1 from pg_database where datname = ${name}`;
    if (found) return false;
    const quoted = (n: string) => `"${n.replace(/"/g, '""')}"`;
    try {
      await sql.unsafe(`create database ${quoted(name)}${template ? ` template ${quoted(template)}` : ''}`);
    } catch (e) {
      if (!template || (e as { code?: string }).code !== '55006') throw e;
      await sql.unsafe(`create database ${quoted(name)}`);
    }
    return true;
  } catch (e) {
    // Two creators at once: the other one made it.
    if ((e as { code?: string }).code === '42P04') return false;
    throw e;
  } finally {
    await sql.end();
  }
}

/** True when database `name` exists on the server `adminUrl` names. */
export async function databaseExists(name: string, adminUrl: string = config.databaseAdminUrl): Promise<boolean> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    return (await sql`select 1 from pg_database where datname = ${name}`).length > 0;
  } finally {
    await sql.end();
  }
}
