import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import type { Db } from '@/platform/db/client';

/**
 * The integration tests' "the database" in `per_workspace` mode (D35): a drizzle Db over two
 * databases, the control plane and the test file's workspace database (where the file's tenants are
 * placed). Tests read and write through `adminDb` as if there were one database; each statement goes
 * where its tables are:
 * - `tenancy.*` (and `platform.ping_result`): the control plane.
 * - a platform table both hold (outbox, audit log, schedules, dead jobs, ...): a write naming
 *   `t_platform` goes to the control plane, any other insert to the workspace database; reads,
 *   updates and deletes run on both and their results are put together (rows one after the other;
 *   a single row of numbers, such as a count, added up).
 * - any other module schema: the workspace database.
 * - DDL a test runs (its own trigger, say): both databases for the platform schema, the workspace one
 *   for another module schema. String literals and function bodies are not looked at.
 * - an advisory lock a test holds: the workspace database, where workspace code takes its locks.
 * - neither (`select 1`, the catalog): the control plane.
 * Only for tests: production code always picks its database through the doors.
 */

type Sql = postgres.Sql;
type Target = 'control' | 'workspace' | 'both';

const CONTROL_ONLY = /"?tenancy"?\s*\.|"?platform"?\s*\.\s*"?ping_result\b/i;
const BOTH = /"?platform"?\s*\.\s*"?(outbox|processed_event|idempotency_key|dead_job|delivery_attempt|schedule|audit_log)\b/i;
const WORKSPACE = /"?(platform|integrations|ai|offers|accounts|intake|scoring|routing|crm|playbooks)"?\s*\.\s*"?[a-z_]+/i;

const DDL = /^\s*(create|drop|alter|truncate|comment|grant|revoke)\b/i;
const ADVISORY = /\bpg_(try_)?advisory/i;

function targetOf(raw: string, params: unknown[] = []): Target {
  // Tables are named in the SQL, not in its comments, string literals or function bodies.
  const query = raw
    .replace(/--[^\n]*/g, '')
    .replace(/\$\$[\s\S]*?\$\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''");
  const platformTable = /"?platform"?\s*\.\s*"?[a-z_]+/i;
  if (CONTROL_ONLY.test(query)) return 'control';
  // A test's own trigger, function or table: on both databases when it is in the platform schema
  // (each has its tables), else the workspace one for a module schema.
  if (DDL.test(query)) return platformTable.test(query) ? 'both' : WORKSPACE.test(query) ? 'workspace' : 'control';
  // A lock a test holds stands in for workspace code, which takes its locks in the workspace database.
  if (ADVISORY.test(query)) return 'workspace';
  const stripped = query.replace(new RegExp(BOTH.source, 'gi'), '');
  if (BOTH.test(query) && !WORKSPACE.test(stripped)) {
    if (params.includes('t_platform') || /'t_platform'/.test(raw)) return 'control';
    return /^\s*insert\b/i.test(query) ? 'workspace' : 'both';
  }
  return WORKSPACE.test(query) ? 'workspace' : 'control';
}

type Rows = unknown[] & { count?: number; command?: string; columns?: unknown };

const numeric = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));

/** Puts two results together: a single row of numbers each is added up, else rows one after the other. */
function merge(a: Rows, b: Rows): Rows {
  let out: Rows;
  const one = (r: Rows) => r.length === 1 && Object.values(r[0] as object).every(numeric);
  if (one(a) && one(b) && JSON.stringify(Object.keys(a[0] as object)) === JSON.stringify(Object.keys(b[0] as object))) {
    const sum: Record<string, unknown> = {};
    for (const k of Object.keys(a[0] as object)) {
      const x = (a[0] as Record<string, unknown>)[k];
      const y = (b[0] as Record<string, unknown>)[k];
      const total = Number(x) + Number(y);
      sum[k] = typeof x === 'string' ? String(total) : total;
    }
    out = Array.isArray(a[0]) ? ([Object.values(sum)] as Rows) : ([sum] as Rows);
  } else {
    out = [...a, ...b] as Rows;
  }
  // As postgres.js has them: not enumerable, so a test comparing rows sees only rows.
  const meta = { count: (a.count ?? a.length) + (b.count ?? b.length), command: a.command, columns: a.columns };
  for (const [k, v] of Object.entries(meta)) Object.defineProperty(out, k, { value: v, enumerable: false });
  return out;
}

type Client = { control: Sql; workspace: Sql };

function routerClient(c: Client): Sql {
  const run = (target: Target, values: boolean, query: string, params?: unknown[], opts?: unknown): Promise<Rows> => {
    const one = (sql: Sql) => {
      const q = sql.unsafe(query, params as never[], opts as never);
      return (values ? q.values() : q) as unknown as Promise<Rows>;
    };
    if (target === 'control') return one(c.control);
    if (target === 'workspace') return one(c.workspace);
    // The control plane's rows first: a test's new rows are mostly the workspace's, and come last as they would.
    return Promise.all([one(c.control), one(c.workspace)]).then(([k, w]) => merge(k, w));
  };
  const client = {
    options: c.control.options,
    unsafe(query: string, params?: unknown[], opts?: unknown) {
      const target = targetOf(query, params);
      return {
        values: () => run(target, true, query, params, opts),
        then: (ok?: (v: Rows) => unknown, fail?: (e: unknown) => unknown) => run(target, false, query, params, opts).then(ok, fail),
      };
    },
    // A transaction on both databases at once; each statement still goes where its tables are.
    begin(fn: (tx: Sql) => Promise<unknown>) {
      return c.workspace.begin((w) => c.control.begin((k) => fn(routerClient({ control: k as unknown as Sql, workspace: w as unknown as Sql }))));
    },
    savepoint(fn: (tx: Sql) => Promise<unknown>) {
      const w = c.workspace as unknown as { savepoint: (f: (s: Sql) => Promise<unknown>) => Promise<unknown> };
      const k = c.control as unknown as { savepoint: (f: (s: Sql) => Promise<unknown>) => Promise<unknown> };
      return w.savepoint((ws) => k.savepoint((ks) => fn(routerClient({ control: ks, workspace: ws }))));
    },
  };
  return client as unknown as Sql;
}

/** A drizzle Db over the control plane and one workspace database, statements routed as above. */
export function routedDb(control: Sql, workspace: Sql): Db {
  // Drizzle sets its parsers and serializers on the client it is given (jsonb sent as drizzle's own
  // text, say); both real clients need them, not only the one whose options the router shows.
  drizzle(control);
  drizzle(workspace);
  return drizzle(routerClient({ control, workspace })) as unknown as Db;
}
