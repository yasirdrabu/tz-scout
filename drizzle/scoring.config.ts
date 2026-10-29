import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/modules/scoring/db/schema.ts',
  out: 'src/modules/scoring/db/migrations',
  schemaFilter: ['scoring'],
  migrations: { schema: 'scoring', table: '__migrations' },
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout' },
});
