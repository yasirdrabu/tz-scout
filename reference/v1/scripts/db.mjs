// Runs Postgres on its own (for tests, prisma studio, or the worker). Ctrl+C stops it.
import { startPostgres, PG_PORT } from "./pg.mjs";

const { pg } = await startPostgres();
console.log(`Postgres running on port ${PG_PORT}. Ctrl+C to stop.`);
const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
