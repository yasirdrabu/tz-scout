// One command for local dev: start Postgres, sync the schema, seed on first run, then start Next.js on 4240.
// Pass --seed to reseed. Everything runs through node directly so paths with spaces work on Windows.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPostgres, PG_PORT } from "./pg.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const node = process.execPath;
const BIN = {
  prisma: path.join(root, "node_modules", "prisma", "build", "index.js"),
  tsx: path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
  next: path.join(root, "node_modules", "next", "dist", "bin", "next"),
};
const env = { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" };
const run = (bin, args) => {
  const r = spawnSync(node, [bin, ...args], { stdio: "inherit", env });
  if (r.status !== 0) throw new Error(`${path.basename(bin)} ${args.join(" ")} failed`);
};

const { pg, fresh, reused } = await startPostgres();
console.log(`[dev] Postgres on ${PG_PORT}${reused ? " (already running)" : fresh ? " (new data directory)" : ""}`);

run(BIN.prisma, ["db", "push", "--skip-generate"]);
if (fresh || process.argv.includes("--seed")) run(BIN.tsx, ["prisma/seed.ts"]);

const next = spawn(node, [BIN.next, "dev", "-p", "4240"], { stdio: "inherit", env });

const stop = async () => {
  next.kill();
  if (pg) await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
next.on("exit", async (code) => {
  if (pg) await pg.stop();
  process.exit(code ?? 0);
});
