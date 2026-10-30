import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/modules/crm/db/schema.ts',
  out: 'src/modules/crm/db/migrations',
  schemaFilter: ['crm'],
  migrations: { schema: 'crm', table: '__migrations' },
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout' },
});
