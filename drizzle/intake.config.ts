import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/modules/intake/db/schema.ts',
  out: 'src/modules/intake/db/migrations',
  schemaFilter: ['intake'],
  migrations: { schema: 'intake', table: '__migrations' },
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout' },
});
