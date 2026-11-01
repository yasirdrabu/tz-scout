// Shared by playwright.config.ts (web server env) and global-setup.ts (database + seed).

export const E2E_DB = 'scout_e2e';
/** The backend (`scout web`: the API at /api/v1, sign-in at /api/auth, the health checks). */
export const E2E_PORT = 4240;
/** The web-ui Vite dev server the specs drive. It proxies /api and the health checks to the backend. */
export const E2E_APP_PORT = 5273;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const base = {
  app: process.env.DATABASE_URL ?? 'postgres://scout_app:scout_app@localhost:5432/scout',
  admin: process.env.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout',
};

/** Environment for the app under test: a throwaway database, developer sign-in on, mocks only. */
export const e2eEnv: Record<string, string> = {
  NODE_ENV: 'development',
  DATABASE_URL: withDatabase(base.app, E2E_DB),
  DATABASE_ADMIN_URL: withDatabase(base.admin, E2E_DB),
  AUTH_DEV_SIGNIN: 'true',
  SCOUT_FORCE_MOCK: 'true',
  APP_PUBLIC_URL: `http://localhost:${E2E_PORT}`,
  SCOUT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  AUTH_SECRET: 'e2e-only-secret-not-for-use-anywhere-else',
};
