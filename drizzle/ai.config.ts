import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/modules/ai/db/schema.ts',
  out: 'src/modules/ai/db/migrations',
  schemaFilter: ['ai'],
  migrations: { schema: 'ai', table: '__migrations' },
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout' },
});
