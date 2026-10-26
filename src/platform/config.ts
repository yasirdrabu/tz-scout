import { z } from 'zod';

export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  databaseUrl: string;
  databaseAdminUrl: string;
  /** Superuser connection; only for creating roles and test databases. Optional in production. */
  databaseSuperuserUrl: string;
  /** Connections in the appDb pool. The worker caps messages in flight below this. */
  databasePoolMax: number;
  natsUrl: string;
  masterKey?: Buffer;
  masterKeyPrevious?: Buffer;
  /** Key version stamped on new credentials. The previous key is version - 1. */
  masterKeyVersion: number;
  authSecret: string;
  authDevSignin: boolean;
  forceMock: boolean;
  /**
   * Microsoft Entra app. `tenantId` is Scout's home tenant (or common/organizations); people may be
   * matched by email on first sign-in only when their token's tenant is in `allowedTenantIds`.
   */
  azureAd?: { tenantId: string; clientId: string; clientSecret: string; allowedTenantIds: string[] };
  publicUrl: string;
};

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_ADMIN_URL: z.string().min(1).optional(),
  DATABASE_SUPERUSER_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(500).default(20),
  NATS_URL: z.string().min(1).optional(),
  SCOUT_MASTER_KEY: z.string().optional(),
  SCOUT_MASTER_KEY_PREVIOUS: z.string().optional(),
  SCOUT_MASTER_KEY_VERSION: z.coerce.number().int().min(1).max(100000).default(1),
  AUTH_SECRET: z.string().min(1).optional(),
  AUTH_DEV_SIGNIN: bool,
  SCOUT_FORCE_MOCK: bool,
  AZURE_AD_TENANT_ID: z.string().min(1).optional(),
  AZURE_AD_CLIENT_ID: z.string().min(1).optional(),
  AZURE_AD_CLIENT_SECRET: z.string().min(1).optional(),
  AZURE_AD_ALLOWED_TENANT_IDS: z.string().optional(),
  APP_PUBLIC_URL: z.string().min(1).optional(),
});

function parseKey(name: string, value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const v = value.trim();
  const buf = Buffer.from(v, 'base64');
  if (buf.length !== 32 || buf.toString('base64') !== v) {
    throw new Error(`${name} must be 32 bytes, base64`);
  }
  return buf;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Comma list of Entra tenant GUIDs; defaults to the home tenant when that is a GUID. */
function allowedTenants(list: string | undefined, home: string): string[] {
  if (list === undefined) return GUID.test(home.toLowerCase()) ? [home.toLowerCase()] : [];
  const ids = list
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const bad = ids.find((v) => !GUID.test(v));
  if (bad) throw new Error('AZURE_AD_ALLOWED_TENANT_IDS must be a comma list of Entra tenant ids (GUIDs)');
  return ids;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // dotenv and Next load `KEY=` as an empty string; treat that as unset.
  const cleaned: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) cleaned[k] = v === '' ? undefined : v;
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const e = parsed.data;

  if (e.NODE_ENV === 'production') {
    if (e.AUTH_DEV_SIGNIN) throw new Error('AUTH_DEV_SIGNIN must be false in production');
    if (!e.SCOUT_MASTER_KEY) throw new Error('SCOUT_MASTER_KEY is required in production');
    for (const k of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'NATS_URL', 'AUTH_SECRET', 'APP_PUBLIC_URL'] as const) {
      if (!e[k]) throw new Error(`${k} is required in production`);
    }
  }

  const masterKey = parseKey('SCOUT_MASTER_KEY', e.SCOUT_MASTER_KEY);
  const masterKeyPrevious = parseKey('SCOUT_MASTER_KEY_PREVIOUS', e.SCOUT_MASTER_KEY_PREVIOUS);

  const azureAd =
    e.AZURE_AD_TENANT_ID && e.AZURE_AD_CLIENT_ID && e.AZURE_AD_CLIENT_SECRET
      ? {
          tenantId: e.AZURE_AD_TENANT_ID,
          clientId: e.AZURE_AD_CLIENT_ID,
          clientSecret: e.AZURE_AD_CLIENT_SECRET,
          allowedTenantIds: allowedTenants(e.AZURE_AD_ALLOWED_TENANT_IDS, e.AZURE_AD_TENANT_ID),
        }
      : undefined;

  return {
    nodeEnv: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL ?? 'postgres://scout_app:scout_app@localhost:5432/scout',
    databaseAdminUrl: e.DATABASE_ADMIN_URL ?? 'postgres://scout_admin:scout_admin@localhost:5432/scout',
    databaseSuperuserUrl: e.DATABASE_SUPERUSER_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
    databasePoolMax: e.DATABASE_POOL_MAX,
    natsUrl: e.NATS_URL ?? 'nats://localhost:4222',
    masterKey,
    masterKeyPrevious,
    masterKeyVersion: e.SCOUT_MASTER_KEY_VERSION,
    authSecret: e.AUTH_SECRET ?? 'dev-only-insecure-auth-secret',
    authDevSignin: e.AUTH_DEV_SIGNIN,
    forceMock: e.SCOUT_FORCE_MOCK,
    azureAd,
    publicUrl: e.APP_PUBLIC_URL ?? 'http://localhost:4240',
  };
}

let cached: Config | undefined;
const get = (): Config => (cached ??= loadConfig());

/** Lazy, memoised config. The environment is read on first property access. */
export const config: Config = new Proxy({} as Config, {
  get: (_t, prop) => get()[prop as keyof Config],
  has: (_t, prop) => prop in get(),
  ownKeys: () => Reflect.ownKeys(get()),
  getOwnPropertyDescriptor: (_t, prop) => Object.getOwnPropertyDescriptor(get(), prop),
});
