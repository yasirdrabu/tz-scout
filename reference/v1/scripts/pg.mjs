// Local Postgres for development: real Postgres binaries from npm, no Docker, no admin rights.
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PG_PORT = Number(process.env.PG_PORT ?? 5440);
const dataDir = path.join(root, ".pgdata");

async function ensureDatabases(databases) {
  const client = new pg.Client({ host: "localhost", port: PG_PORT, user: "acq", password: "acq", database: "postgres" });
  await client.connect();
  for (const db of databases) {
    const r = await client.query("select 1 from pg_database where datname = $1", [db]);
    // UTF-8 regardless of the Windows locale the cluster was created with (it defaults to WIN1252,
    // which can't store characters like arrows, emoji or most non-Latin names).
    if (r.rowCount === 0) await client.query(`create database ${db} encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
  }
  await client.end();
}

async function alreadyRunning() {
  const client = new pg.Client({ host: "localhost", port: PG_PORT, user: "acq", password: "acq", database: "postgres", connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

/** Starts Postgres, or reuses one already running on PG_PORT. `pg` is null when reused. */
export async function startPostgres({ databases = ["acq", "acq_test"] } = {}) {
  if (await alreadyRunning()) {
    await ensureDatabases(databases);
    return { pg: null, fresh: false, reused: true };
  }
  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "acq",
    password: "acq",
    port: PG_PORT,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: (e) => console.error("[postgres]", String(e).trim()),
  });
  const fresh = !fs.existsSync(path.join(dataDir, "PG_VERSION"));
  if (fresh) await server.initialise();
  await server.start();
  await ensureDatabases(databases);
  return { pg: server, fresh, reused: false };
}
