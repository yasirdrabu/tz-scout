import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/modules/offers/db/schema.ts',
  out: 'src/modules/offers/db/migrations',
  schemaFilter: ['offers'],
  migrations: { schema: 'offers', table: '__migrations' },
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout' },
});
