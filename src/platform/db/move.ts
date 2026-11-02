import { pipeline } from 'node:stream/promises';
import postgres from 'postgres';
import { WORKSPACE_MODULES } from './migrate';

/**
 * Moving one tenant's rows between databases (D35 "Moving existing workspaces"): every table of the
 * workspace schemas, in foreign key order, with `COPY (SELECT … WHERE tenant_id = …)`. Runs as
 * `scout_admin` on both sides (row level security off), so the selection is the tenant filter below.
 */

/** Platform-wide tables that never move: they hold no workspace's rows. */
const STAYS = new Set(['platform.ping_result']);

/**
 * Tables without `tenant_id` whose rows belong to a tenant through its outbox: what its consumers and
 * jobs have handled (by event or job id).
 */
const BY_EVENT = new Set(['platform.processed_event', 'platform.delivery_attempt']);

/** Tenancy's events stay in the control plane's outbox, where tenancy publishes them. */
const CONTROL_EVENTS = `(payload->>'type' like 'tenancy.%' or payload->>'type' like 'jobs.tenancy.%')`;

const TENANT_ID = /^t_[0-9A-Za-z]+$/;

export type TableCount = { table: string; rows: number };

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const qualified = (table: string) => table.split('.').map(ident).join('.');

/** The rows of `table` that belong to `tenantId`, as a WHERE clause. */
function tenantRows(table: string, tenantId: string): string {
  const t = `'${tenantId}'`;
  if (BY_EVENT.has(table)) return `event_id in (select id from platform.outbox where tenant_id = ${t})`;
  if (table === 'platform.outbox') return `tenant_id = ${t} and not ${CONTROL_EVENTS}`;
  return `tenant_id = ${t}`;
}

/**
 * The tables to move, parents before children (foreign keys within a schema), from the database
 * `sql` is connected to. Refuses (throws) when a table has rows it cannot attribute to a tenant: no
 * `tenant_id` and not a known per-event table.
 */
async function movingTables(sql: postgres.Sql): Promise<string[]> {
  const schemas = WORKSPACE_MODULES as readonly string[];
  const rows = await sql<{ name: string; tenant: boolean }[]>`
    select n.nspname || '.' || c.relname as name,
      exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) as tenant
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and c.relname <> '__migrations' and n.nspname = any(${schemas as string[]})
    order by 1`;
  const unknown = rows.filter((r) => !r.tenant && !BY_EVENT.has(r.name) && !STAYS.has(r.name)).map((r) => r.name);
  if (unknown.length > 0) throw new Error(`These tables have no tenant_id, so their rows cannot be moved: ${unknown.join(', ')}`);
  const tables = rows.filter((r) => !STAYS.has(r.name)).map((r) => r.name);
  const fks = await sql<{ child: string; parent: string }[]>`
    select cn.nspname || '.' || cc.relname as child, pn.nspname || '.' || pc.relname as parent
    from pg_constraint k
    join pg_class cc on cc.oid = k.conrelid join pg_namespace cn on cn.oid = cc.relnamespace
    join pg_class pc on pc.oid = k.confrelid join pg_namespace pn on pn.oid = pc.relnamespace
    where k.contype = 'f' and cn.nspname = any(${schemas as string[]})`;
  // Parents first; a table referring to itself is copied in one statement, which its checks allow.
  const parents = new Map(tables.map((t) => [t, new Set(fks.filter((f) => f.child === t && f.parent !== t).map((f) => f.parent))]));
  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ordered.length < tables.length) {
    const ready = tables.filter((t) => !placed.has(t) && [...parents.get(t)!].every((p) => placed.has(p) || !parents.has(p)));
    if (ready.length === 0) throw new Error('The workspace tables refer to each other in a cycle; they cannot be copied in order.');
    for (const t of ready) {
      ordered.push(t);
      placed.add(t);
    }
  }
  // The per-event tables select through the outbox, so they go after it (and are deleted before it).
  return [...ordered.filter((t) => !BY_EVENT.has(t)), ...ordered.filter((t) => BY_EVENT.has(t))];
}

const count = async (sql: postgres.Sql, table: string, tenantId: string) =>
  (await sql.unsafe(`select count(*)::int as n from ${qualified(table)} where ${tenantRows(table, tenantId)}`))[0]!.n as number;

/**
 * Copies `tenantId`'s rows from the database `fromUrl` names into the (migrated, empty) one `toUrl`
 * names, then checks that every table has the same number of rows on both sides. Sequences on the
 * target are moved past the copied values. Throws on any difference; the caller drops the target.
 */
export async function copyTenantRows(fromUrl: string, toUrl: string, tenantId: string): Promise<TableCount[]> {
  if (!TENANT_ID.test(tenantId)) throw new Error(`Not a tenant id: ${tenantId}`);
  const from = postgres(fromUrl, { max: 1, onnotice: () => {} });
  const to = postgres(toUrl, { max: 1, onnotice: () => {} });
  try {
    const tables = await movingTables(from);
    const out: TableCount[] = [];
    for (const table of tables) {
      // The target's column list, so both sides agree whatever order the columns were added in.
      const cols = (
        await to<{ c: string }[]>`select attname as c from pg_attribute where attrelid = ${table}::regclass and attnum > 0 and not attisdropped order by attnum`
      ).map((r) => ident(r.c));
      if (cols.length === 0) throw new Error(`${table} is not in the target database; migrate it first.`);
      const list = cols.join(', ');
      const reading = await from.unsafe(`copy (select ${list} from ${qualified(table)} where ${tenantRows(table, tenantId)}) to stdout`).readable();
      const writing = await to.unsafe(`copy ${qualified(table)} (${list}) from stdin`).writable();
      await pipeline(reading, writing);
      // The target holds this tenant alone, so every row there counts (its outbox lacks tenancy's events,
      // which the per-event tables are selected through on the source).
      const source = await count(from, table, tenantId);
      const target = (await to.unsafe(`select count(*)::int as n from ${qualified(table)}`))[0]!.n as number;
      if (source !== target) throw new Error(`${table}: ${source} rows in the source, ${target} copied.`);
      out.push({ table, rows: source });
    }
    // Serial columns: the next value must follow what was copied in.
    const serials = await to<{ seq: string; tbl: string; col: string }[]>`
      select pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) as seq,
        quote_ident(n.nspname) || '.' || quote_ident(c.relname) as tbl, quote_ident(a.attname) as col
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and n.nspname = any(${WORKSPACE_MODULES as string[]})
        and pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) is not null`;
    for (const s of serials) {
      await to.unsafe(`select setval('${s.seq.replace(/'/g, "''")}', greatest((select max(${s.col}) from ${s.tbl}), 1))`);
    }
    return out;
  } finally {
    await Promise.all([from.end(), to.end()]);
  }
}

/** Rows deleted per statement: each is its own short transaction, so no lock is held for long. */
export const DELETE_BATCH = 5000;

/**
 * Deletes `tenantId`'s rows from the database `url` names (the shared one, once the workspace has
 * moved), `batch` rows per statement, each statement on its own. That is safe because the registry
 * already points away: nothing reads or writes these rows any more. The per-event tables go first
 * (they are found through the outbox), then children before parents. Safe to run again, also after a
 * crash part way. Returns what it deleted.
 */
export async function deleteTenantRows(url: string, tenantId: string, batch = DELETE_BATCH): Promise<TableCount[]> {
  if (!TENANT_ID.test(tenantId)) throw new Error(`Not a tenant id: ${tenantId}`);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const tables = await movingTables(sql);
    const order = [...tables.filter((t) => BY_EVENT.has(t)), ...tables.filter((t) => !BY_EVENT.has(t)).reverse()];
    const out: TableCount[] = [];
    for (const table of order) {
      const t = qualified(table);
      let rows = 0;
      for (;;) {
        const gone = await sql.unsafe(`delete from ${t} where ctid in (select ctid from ${t} where ${tenantRows(table, tenantId)} limit ${batch})`);
        rows += gone.count;
        if (gone.count < batch) break;
      }
      out.push({ table, rows });
    }
    return out;
  } finally {
    await sql.end();
  }
}

/** How many of `tenantId`'s rows each table of the database `url` names holds (for checks and the CLI). */
export async function countTenantRows(url: string, tenantId: string): Promise<TableCount[]> {
  if (!TENANT_ID.test(tenantId)) throw new Error(`Not a tenant id: ${tenantId}`);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const out: TableCount[] = [];
    for (const table of await movingTables(sql)) out.push({ table, rows: await count(sql, table, tenantId) });
    return out;
  } finally {
    await sql.end();
  }
}
