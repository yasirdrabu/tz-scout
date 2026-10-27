import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/modules/accounts/db/schema.ts',
  out: 'src/modules/accounts/db/migrations',
  schemaFilter: ['accounts'],
  migrations: { schema: 'accounts', table: '__migrations' },
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout' },
});
