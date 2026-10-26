import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/modules/tenancy/db/schema.ts',
  out: 'src/modules/tenancy/db/migrations',
  schemaFilter: ['tenancy'],
  migrations: { schema: 'tenancy', table: '__migrations' },
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout' },
});
