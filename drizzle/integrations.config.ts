import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/modules/integrations/db/schema.ts',
  out: 'src/modules/integrations/db/migrations',
  schemaFilter: ['integrations'],
  migrations: { schema: 'integrations', table: '__migrations' },
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout' },
});
