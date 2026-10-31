import { beforeAll, describe, expect, it, vi } from 'vitest';

const over: Record<string, unknown> = {};
vi.mock('@/platform/config', async (orig) => {
  const real = await orig<typeof import('@/platform/config')>();
  return {
    ...real,
    config: new Proxy(real.config, {
      get: (t, p) => (p in over ? over[p as string] : (t as never)[p]),
    }),
  };
});

const { GET: authConfig } = await import('@/http/routes/v1/auth/config/route');
const { GET: devUsers } = await import('@/http/routes/v1/dev/users/route');
const { seedUser } = await import('../tenancy/helpers');
const { adminDb } = await import('@/platform/db/client');
const { user } = await import('@/modules/tenancy/db/schema');
const { eq } = await import('drizzle-orm');

const get = (h: (r: Request) => Promise<Response>, path: string) => h(new Request(`http://localhost:4240/v1${path}`));

describe('GET /v1/auth/config', () => {
  it('needs no sign-in and names the sign-in methods and the dev sign-in flag', async () => {
    over.azureAd = undefined;
    over.authDevSignin = false;
    const off = await get(authConfig, '/auth/config');
    expect(off.status).toBe(200);
    expect(off.headers.get('x-correlation-id')).toMatch(/^cor_/);
    expect(await off.json()).toEqual({ methods: [], dev_sign_in: false });

    over.azureAd = { tenantId: 't', clientId: 'c', clientSecret: 's', allowedTenantIds: [] };
    over.authDevSignin = true;
    expect(await (await get(authConfig, '/auth/config')).json()).toEqual({ methods: ['microsoft'], dev_sign_in: true });
  });
});

describe('GET /v1/dev/users', () => {
  let active: Awaited<ReturnType<typeof seedUser>>;
  let off: Awaited<ReturnType<typeof seedUser>>;
  beforeAll(async () => {
    active = await seedUser({ admin: true });
    off = await seedUser();
    await adminDb.update(user).set({ disabledAt: new Date() }).where(eq(user.id, off.id));
  });

  it('404 problem when dev sign-in is off', async () => {
    over.authDevSignin = false;
    const res = await get(devUsers, '/dev/users');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect((await res.json()).type).toMatch(/\/not-found$/);
  });

  it('lists people who are not turned off, in snake_case, when on', async () => {
    over.authDevSignin = true;
    const res = await get(devUsers, '/dev/users');
    expect(res.status).toBe(200);
    const list = (await res.json()) as { id: string }[];
    expect(list).toContainEqual({ id: active.id, email: active.email, name: active.email.split('@')[0], platform_admin: true });
    expect(list.some((u) => u.id === off.id)).toBe(false);
  });
});
