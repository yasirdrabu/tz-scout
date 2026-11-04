import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/modules/enrichment/db/schema.ts',
  out: 'src/modules/enrichment/db/migrations',
  schemaFilter: ['enrichment'],
  migrations: { schema: 'enrichment', table: '__migrations' },
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout' },
});
