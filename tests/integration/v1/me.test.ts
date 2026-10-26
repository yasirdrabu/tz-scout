import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as me } from '@/app/v1/me/route';
import { assertSameSite, v1Route } from '@/app/v1/_lib/v1-route';
import { SYSTEM_GRANTOR, createApiKey, createTenant, revokeApiKey, setPrincipalCacheTtl } from '@/modules/tenancy';
import { membership } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';

const mk = (ctx: Parameters<typeof createApiKey>[0], input: Parameters<typeof createApiKey>[1]) =>
  createApiKey(ctx, input, SYSTEM_GRANTOR);

let tenantId: string;
let slug: string;
let owner: Awaited<ReturnType<typeof seedUser>>;

beforeAll(async () => {
  const admin = await seedUser({ admin: true });
  owner = await seedUser({ signedIn: true });
  slug = uniqueSlug();
  const t = await createTenant(admin.actor, {
    slug,
    name: 'Me Co',
    currency: 'USD',
    timezone: 'UTC',
    ownerEmail: owner.email,
  });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  tenantId = t.tenantId;
});
beforeEach(() => setPrincipalCacheTtl(0));

const call = (h: (r: Request) => Promise<Response>, secret?: string, headers: Record<string, string> = {}) =>
  h(
    new Request('http://x/v1/me', {
      headers: {
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...headers,
      },
    }),
  );
const make = (scopes: string[]) =>
  inTenant(tenantId, owner.actor, (ctx) =>
    mk(ctx, {
      name: 'k',
      environment: 'live',
      scopes: scopes as never,
    }),
  );

describe('GET /v1/me', () => {
  it('returns the key identity in snake_case with a correlation id', async () => {
    const { id, secret } = await make(['members:read', 'status:read']);
    const res = await call(me, secret, { 'x-correlation-id': 'cor_mine' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-correlation-id')).toBe('cor_mine');
    expect(await res.json()).toEqual({
      tenant: { id: tenantId, slug, name: 'Me Co' },
      kind: 'api_key',
      id,
      scopes: ['members:read', 'status:read'],
      data_limit: { kind: 'own_source' },
      source_id: null,
      environment: 'live',
    });
  });

  it('makes a correlation id when none is sent', async () => {
    const { secret } = await make(['members:read']);
    expect((await call(me, secret)).headers.get('x-correlation-id')).toMatch(/^cor_/);
  });

  it('401 unauthenticated without credentials, with a wrong secret', async () => {
    const none = await call(me);
    expect(none.status).toBe(401);
    expect(none.headers.get('content-type')).toContain('application/problem+json');
    expect((await none.json()).type).toBe('https://scout.taazaa.ai/problems/unauthenticated');
    const { secret } = await make(['members:read']);
    const bad = await call(me, secret.slice(0, -1) + (secret.endsWith('a') ? 'b' : 'a'));
    expect(bad.status).toBe(401);
    expect((await bad.json()).type).toMatch(/\/unauthenticated$/);
  });

  it('401 key-revoked after revoke (TEN-E4-S3-AC2)', async () => {
    const { id, secret } = await make(['members:read']);
    expect((await call(me, secret)).status).toBe(200);
    await inTenant(tenantId, owner.actor, (ctx) => revokeApiKey(ctx, id, 'test'));
    const res = await call(me, secret);
    expect(res.status).toBe(401);
    expect((await res.json()).type).toMatch(/\/key-revoked$/);
  });
});

describe('v1Route', () => {
  const guarded = v1Route({ permission: 'members:read' }, async () => ({
    fooBar: { bazQux: [{ innerKey: 1 }] },
    at: new Date(0),
  }));

  it('403 with the key copy when the scope is missing', async () => {
    const { secret } = await make(['status:read']);
    const res = await call(guarded, secret);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.detail).toBe("This key can't do that. It needs the `members:read` scope.");
    expect(body.type).toMatch(/\/forbidden$/);
  });

  it('serialises nested objects as snake_case', async () => {
    const { secret } = await make(['members:read']);
    const res = await call(guarded, secret);
    expect(await res.json()).toEqual({
      foo_bar: { baz_qux: [{ inner_key: 1 }] },
      at: '1970-01-01T00:00:00.000Z',
    });
  });

  it('turns unexpected errors into a 500 problem', async () => {
    const boom = v1Route({}, async () => {
      throw new Error('x');
    });
    const { secret } = await make([]);
    const res = await call(boom, secret);
    expect(res.status).toBe(500);
    expect((await res.json()).type).toMatch(/\/internal$/);
  });
});

describe('hardening', () => {
  it('401 carries WWW-Authenticate: Bearer', async () => {
    expect((await call(me)).headers.get('www-authenticate')).toBe('Bearer');
  });

  it('reports the environment', async () => {
    const { secret } = await make(['members:read']);
    expect((await (await call(me, secret)).json()).environment).toBe('live');
  });

  it('replaces an odd client correlation id', async () => {
    const { secret } = await make(['members:read']);
    for (const bad of ['bad id with spaces', 'x'.repeat(129), 'a<b>']) {
      expect((await call(me, secret, { 'x-correlation-id': bad })).headers.get('x-correlation-id')).toMatch(/^cor_/);
    }
  });

  it('blocks cookie writes without our origin and a tenant header (CSRF)', () => {
    const post = (h: Record<string, string>, method = 'POST') => new Request('http://x/v1/y', { method, headers: h });
    const origin = 'http://localhost:4240';
    expect(() => assertSameSite(post({}))).toThrow(expect.objectContaining({ slug: 'csrf', status: 403 }));
    expect(() => assertSameSite(post({ origin, 'x-scout-tenant': 'a' }, 'GET'))).not.toThrow();
    expect(() => assertSameSite(post({ 'x-scout-tenant': 'a' }))).toThrow(expect.objectContaining({ slug: 'csrf' }));
    expect(() => assertSameSite(post({ origin }))).toThrow(expect.objectContaining({ slug: 'csrf' }));
    expect(() => assertSameSite(post({ origin: 'https://evil.example', 'x-scout-tenant': 'a' }))).toThrow(
      expect.objectContaining({ slug: 'csrf' }),
    );
    expect(() => assertSameSite(post({ origin, 'x-scout-tenant': 'a' }))).not.toThrow();
    expect(() => assertSameSite(new Request('http://x/v1/y', { method: 'GET' }))).not.toThrow();
  });
});
