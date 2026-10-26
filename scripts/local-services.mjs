// Runs Postgres 17 and NATS (JetStream) without Docker, for machines where Docker is not available.
// Postgres: the `embedded-postgres` package, data in .pgdata/, port 5432, superuser postgres/postgres.
// NATS: the official nats-server release binary, downloaded once into .tools/nats-server/.
// Runs until Ctrl+C. The primary path is still `docker compose -f infra/compose/docker-compose.yml up`.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NATS_VERSION = 'v2.11.16';
const PG_PORT = 5432;
const DB = 'scout';

function natsAsset() {
  const os = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!os || !arch || (os === 'windows' && arch !== 'amd64')) {
    throw new Error(`No nats-server release for ${process.platform}/${process.arch}`);
  }
  const base = `nats-server-${NATS_VERSION}-${os}-${arch}`;
  return { base, file: os === 'windows' ? `${base}.zip` : `${base}.tar.gz`, exe: os === 'windows' ? 'nats-server.exe' : 'nats-server' };
}

async function ensureNats() {
  const { base, file, exe } = natsAsset();
  const dir = path.join(root, '.tools', 'nats-server');
  const bin = path.join(dir, exe);
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/${file}`;
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
  const archive = path.join(dir, file);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  // Relative names plus cwd avoid GNU tar reading 'C:' as a remote host; Windows uses its own bsdtar.
  const args = [file.endsWith('.zip') ? '-xf' : '-xzf', file];
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
  const r = spawnSync(tar, args, { stdio: 'inherit', cwd: dir });
  if (r.status !== 0) throw new Error('Could not extract the nats-server archive (is `tar` installed?)');
  const extracted = path.join(dir, base, exe);
  if (!existsSync(extracted)) throw new Error(`Expected ${extracted} after extracting`);
  writeFileSync(bin, readFileSync(extracted));
  if (process.platform !== 'win32') chmodSync(bin, 0o755);
  rmSync(path.join(dir, base), { recursive: true, force: true });
  rmSync(archive, { force: true });
  return bin;
}

async function startPostgres() {
  const databaseDir = path.join(root, '.pgdata');
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: true,
    onLog: () => {},
    onError: (e) => console.error('[postgres]', String(e).trim()),
  });
  const fresh = !existsSync(path.join(databaseDir, 'PG_VERSION'));
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase(DB);
  // Roles, schemas and grants. Idempotent, so it is safe on every start.
  const sql = postgres(`postgres://postgres:postgres@localhost:${PG_PORT}/${DB}`, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(readFileSync(path.join(root, 'src/platform/db/bootstrap.sql'), 'utf8'));
  } finally {
    await sql.end();
  }
  return pg;
}

async function main() {
  const natsBin = await ensureNats();
  console.log('Starting Postgres...');
  const pg = await startPostgres();
  console.log(`Postgres ready on localhost:${PG_PORT} (database ${DB}, roles scout_app and scout_admin)`);

  mkdirSync(path.join(root, '.tools', 'nats-data'), { recursive: true });
  const nats = spawn(natsBin, ['-js', '-sd', path.join(root, '.tools', 'nats-data'), '-m', '8222', '-p', '4222'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  nats.on('exit', (code) => {
    if (!stopping) {
      console.error(`nats-server exited (${code})`);
      void shutdown(1);
    }
  });
  console.log('NATS ready on localhost:4222 (monitor 8222). Press Ctrl+C to stop both.');

  let stopping = false;
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping...');
    nats.kill();
    try {
      await pg.stop();
    } catch (e) {
      console.error(e);
    }
    process.exit(code);
  }
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
