import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/modules/routing/db/schema.ts',
  out: 'src/modules/routing/db/migrations',
  schemaFilter: ['routing'],
  migrations: { schema: 'routing', table: '__migrations' },
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout' },
});
