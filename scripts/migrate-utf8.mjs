// One-off: copy the WIN1252 database into a new UTF-8 one, table by table, and verify counts.
// The swap (renaming databases) is a separate step: node scripts/migrate-utf8.mjs --swap
//
//   node scripts/migrate-utf8.mjs <source> <target>        copy and verify
//   node scripts/migrate-utf8.mjs --swap <source> <target>  rename source -> <source>_win1252, target -> source

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conn = (database) => new pg.Client({ host: "localhost", port: 5440, user: "acq", password: "acq", database });
const args = process.argv.slice(2);
const swap = args[0] === "--swap";
const [source, target] = swap ? args.slice(1) : args;
if (!source || !target) throw new Error("usage: migrate-utf8.mjs [--swap] <source> <target>");

if (swap) {
  const admin = conn("postgres");
  await admin.connect();
  const busy = (await admin.query("select datname, count(*)::int n from pg_stat_activity where datname = any($1) group by 1", [[source, target]])).rows;
  if (busy.length) throw new Error(`Close connections first: ${JSON.stringify(busy)}`);
  await admin.query(`alter database ${source} rename to ${source}_win1252`);
  await admin.query(`alter database ${target} rename to ${source}`);
  await admin.end();
  console.log(`Swapped: ${source} is now UTF-8; the old one is ${source}_win1252.`);
  process.exit(0);
}

// 1. Fresh UTF-8 target with the current schema.
const admin = conn("postgres");
await admin.connect();
await admin.query(`drop database if exists ${target}`);
await admin.query(`create database ${target} encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
await admin.end();
execFileSync(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "db", "push", "--skip-generate"], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: `postgresql://acq:acq@localhost:5440/${target}`, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  stdio: "pipe",
});

// 2. Copy every table in public (pg-boss rebuilds its own schema on start).
const src = conn(source);
const dst = conn(target);
await src.connect();
await dst.connect();
await src.query("set client_encoding to 'UTF8'");
await dst.query("set session_replication_role = replica"); // skip FK checks while copying in any order
const tables = (await src.query("select tablename from pg_tables where schemaname = 'public' and tablename <> '_prisma_migrations' order by 1")).rows.map((r) => r.tablename);
const report = [];
for (const t of tables) {
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
await dst.query("set session_replication_role = origin");
await src.end();
await dst.end();
const bad = report.filter((r) => !r.ok);
console.log(`${report.length} tables, ${report.reduce((s, r) => s + r.source, 0)} rows copied.${bad.length ? ` MISMATCH: ${JSON.stringify(bad)}` : " All counts match."}`);
if (bad.length) process.exit(1);
