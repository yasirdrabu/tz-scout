import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: 'src/modules/playbooks/db/schema.ts',
  out: 'src/modules/playbooks/db/migrations',
  schemaFilter: ['playbooks'],
  migrations: { schema: 'playbooks', table: '__migrations' },
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout' },
});
