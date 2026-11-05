import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/modules/analytics/db/schema.ts',
  out: 'src/modules/analytics/db/migrations',
  schemaFilter: ['analytics'],
  migrations: { schema: 'analytics', table: '__migrations' },
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout' },
});
