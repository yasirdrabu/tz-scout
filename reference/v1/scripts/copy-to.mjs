// Copy the laptop database to another Postgres (the Azure one): applies the schema to the target, copies
// every table in foreign-key order (managed Postgres doesn't allow switching FK checks off), and
// verifies row counts. The target must be empty. pg-boss rebuilds its own schema on first start.
//
//   node scripts/copy-to.mjs "<target DATABASE_URL>"            copy and verify
//   node scripts/copy-to.mjs "<target DATABASE_URL>" --source "<source url>"   (default: local acq on 5440)

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--source");
const source = args.includes("--source") ? args[args.indexOf("--source") + 1] : "postgresql://acq:acq@localhost:5440/acq";
if (!target) throw new Error('usage: copy-to.mjs "<target DATABASE_URL>" [--source "<url>"]');
const ssl = (url) => (/sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined);

// 1. Schema on the target.
execFileSync(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "db", "push", "--skip-generate"], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: target, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  stdio: "inherit",
});

const src = new pg.Client({ connectionString: source, ssl: ssl(source) });
const dst = new pg.Client({ connectionString: target, ssl: ssl(target) });
await src.connect();
await dst.connect();
await src.query("set client_encoding to 'UTF8'");
const enc = (await dst.query("show server_encoding")).rows[0].server_encoding;
if (enc !== "UTF8") throw new Error(`The target database is ${enc}; create it as UTF8.`);

// 2. Tables in dependency order: parents before children.
const tables = (await src.query("select tablename from pg_tables where schemaname = 'public' and tablename <> '_prisma_migrations' order by 1")).rows.map((r) => r.tablename);
for (const t of tables) {
  const n = (await dst.query(`select count(*)::int n from "${t}"`)).rows[0].n;
  if (n > 0) throw new Error(`The target already has rows in "${t}". Copy into an empty database.`);
}
const edges = (
  await src.query(`select tc.table_name child, ccu.table_name parent from information_schema.table_constraints tc
    join information_schema.constraint_column_usage ccu on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`)
).rows.filter((e) => e.child !== e.parent);
const order = [];
const left = new Set(tables);
while (left.size) {
  const ready = [...left].filter((t) => !edges.some((e) => e.child === t && left.has(e.parent) && e.parent !== t));
  if (!ready.length) throw new Error(`Circular foreign keys between: ${[...left].join(", ")}`);
  for (const t of ready.sort()) {
    order.push(t);
    left.delete(t);
  }
}

// 3. Copy in one transaction, so a failure leaves the target empty.
const report = [];
await dst.query("begin");
try {
  for (const t of order) {
    const cols = (await dst.query("select column_name, data_type, udt_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position", [t])).rows;
    const names = cols.map((c) => c.column_name);
    const rows = (await src.query(`select ${names.map((n) => `"${n}"`).join(", ")} from "${t}"`)).rows;
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200);
      const values = [];
      const tuples = batch.map((row) =>
        `(${cols
          .map((c) => {
            let v = row[c.column_name];
            if (v != null && (c.data_type === "json" || c.data_type === "jsonb")) v = JSON.stringify(v);
            values.push(v);
            const cast = c.data_type === "USER-DEFINED" ? `::"${c.udt_name}"` : c.data_type === "ARRAY" && c.udt_name.startsWith("_") && !["_text", "_varchar", "_int4", "_int8", "_float8", "_bool"].includes(c.udt_name) ? `::"${c.udt_name.slice(1)}"[]` : "";
            return `$${values.length}${cast}`;
          })
          .join(", ")})`,
      );
      await dst.query(`insert into "${t}" (${names.map((n) => `"${n}"`).join(", ")}) values ${tuples.join(", ")}`, values);
    }
    const n = (await dst.query(`select count(*)::int n from "${t}"`)).rows[0].n;
    report.push({ table: t, source: rows.length, target: n, ok: n === rows.length });
  }
  const bad = report.filter((r) => !r.ok);
  if (bad.length) throw new Error(`Row counts don't match: ${JSON.stringify(bad)}`);
  await dst.query("commit");
} catch (e) {
  await dst.query("rollback");
  throw e;
} finally {
  await src.end();
  await dst.end();
}
console.log(`${report.length} tables, ${report.reduce((s, r) => s + r.source, 0)} rows copied. All counts match.`);
