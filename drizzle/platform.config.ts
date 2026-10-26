import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/platform/db/schema.ts',
  out: 'src/platform/db/migrations',
  schemaFilter: ['platform'],
  migrations: { schema: 'platform', table: '__migrations' },
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout' },
});
