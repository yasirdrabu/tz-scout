import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApiKey,
  createKeyFromCli,
  createTenant,
  registerSourceValidator,
  resolvePrincipal,
  revokeApiKey,
  setPrincipalCacheTtl,
} from '@/modules/tenancy';
import { apiKey, membership, tenant } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { inTenant, seedUser, uniqueSlug } from './helpers';

let tenantId: string;
let slug: string;
let owner: Awaited<ReturnType<typeof seedUser>>;

beforeAll(async () => {
  const admin = await seedUser({ admin: true });
  owner = await seedUser({ signedIn: true });
  slug = uniqueSlug();
  const t = await createTenant(admin.actor, {
    slug,
    name: 'K',
    currency: 'USD',
    timezone: 'UTC',
    ownerEmail: owner.email,
  });
  await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.id, t.ownerMembershipId));
  tenantId = t.tenantId;
});
beforeEach(() => setPrincipalCacheTtl(0));

const req = (secret: string, extra: Record<string, string> = {}) =>
  new Request('http://x/v1/me', {
    headers: { authorization: `Bearer ${secret}`, ...extra },
  });
const make = (scopes: string[] = ['members:read'], environment: 'live' | 'test' = 'live') =>
  inTenant(tenantId, owner.actor, (ctx) => createApiKey(ctx, { name: 'k', environment, scopes: scopes as never }));

describe('createApiKey', () => {
  it('makes a secret of the agreed shape, stores prefix + hash only, and keeps the secret out of rows', async () => {
    const { id, secret } = await make(['members:read', 'status:read']);
    expect(secret).toMatch(/^scout_live_[0-9A-Za-z]{32}$/);
    const [row] = await adminDb.select().from(apiKey).where(eq(apiKey.id, id));
    expect(row!.prefix).toBe(secret.slice(0, 'scout_live_'.length + 8));
    expect(row!.secretHash).toMatch(/^\$argon2id\$/);
    const random = secret.slice('scout_live_'.length);
    for (const table of ['tenancy.api_key', 'platform.outbox', 'platform.audit_log']) {
      const r = (await adminDb.execute(
        sql.raw(`select count(*)::int as n from ${table} t where t::text like '%${random}%'`),
      )) as unknown as { n: number }[];
      expect(r[0]!.n).toBe(0);
    }
    const ev = (await adminDb.execute(
      sql`select payload from platform.outbox where tenant_id = ${tenantId} and payload->>'type' = 'tenancy.api_key.created'`,
    )) as unknown as { payload: { data: { keyId: string } } }[];
    expect(ev.some((e) => e.payload.data.keyId === id)).toBe(true);
  });

  it('uses scout_test_ for test keys', async () => {
    expect((await make(['members:read'], 'test')).secret).toMatch(/^scout_test_/);
  });

  it('refuses arrivals:write while no source validator is registered', async () => {
    await expect(make(['arrivals:write'])).rejects.toThrow(
      'Keys that send accounts need a source. Sources arrive in the next release.',
    );
  });

  it('with a validator, needs an existing source', async () => {
    registerSourceValidator({ exists: async (_c, id) => id === 'src_ok' });
    try {
      await expect(make(['arrivals:write'])).rejects.toMatchObject({
        slug: 'source-required',
      });
      await expect(
        inTenant(tenantId, owner.actor, (ctx) =>
          createApiKey(ctx, {
            name: 'k',
            environment: 'live',
            scopes: ['arrivals:write'],
            sourceId: 'src_bad',
          }),
        ),
      ).rejects.toMatchObject({ slug: 'source-not-found' });
      const { secret } = await inTenant(tenantId, owner.actor, (ctx) =>
        createApiKey(ctx, {
          name: 'k',
          environment: 'live',
          scopes: ['arrivals:write'],
          sourceId: 'src_ok',
        }),
      );
      const p = await resolvePrincipal(req(secret));
      expect(p).toMatchObject({
        kind: 'api_key',
        sourceId: 'src_ok',
        dataLimit: { kind: 'own_source' },
      });
    } finally {
      registerSourceValidator(null);
    }
  });
});

describe('resolvePrincipal with a key', () => {
  it('resolves scopes, tenant and default limit', async () => {
    const { id, secret } = await make(['members:read']);
    const p = await resolvePrincipal(req(secret));
    expect(p).toMatchObject({
      tenantId,
      kind: 'api_key',
      id,
      permissions: ['members:read'],
      platformAdmin: false,
    });
  });

  it('rejects a wrong secret, an unknown prefix and a malformed token with null', async () => {
    const { secret } = await make();
    const wrong = secret.slice(0, -1) + (secret.endsWith('a') ? 'b' : 'a');
    expect(await resolvePrincipal(req(wrong))).toBeNull();
    expect(await resolvePrincipal(req('scout_live_' + 'Z'.repeat(32)))).toBeNull();
    expect(await resolvePrincipal(req('not-a-key'))).toBeNull();
  });

  it('revoked keys fail with key-revoked once the cache is past', async () => {
    const { id, secret } = await make();
    expect(await resolvePrincipal(req(secret))).not.toBeNull();
    await inTenant(tenantId, owner.actor, (ctx) => revokeApiKey(ctx, id, 'leaked'));
    await expect(resolvePrincipal(req(secret))).rejects.toMatchObject({
      slug: 'key-revoked',
      status: 401,
    });
    const ev = (await adminDb.execute(
      sql`select 1 from platform.outbox where tenant_id = ${tenantId} and payload->>'type' = 'tenancy.api_key.revoked' and payload->'data'->>'keyId' = ${id}`,
    )) as unknown as unknown[];
    expect(ev.length).toBe(1);
    const a = await adminDb.select().from(auditLog).where(eq(auditLog.subjectId, id));
    expect(a.map((r) => r.action)).toEqual(
      expect.arrayContaining(['tenancy.api_key.created', 'tenancy.api_key.revoked']),
    );
  });

  it('expired keys fail with key-expired', async () => {
    const { id, secret } = await make();
    await adminDb
      .update(apiKey)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKey.id, id));
    await expect(resolvePrincipal(req(secret))).rejects.toMatchObject({
      slug: 'key-expired',
      status: 401,
    });
  });

  it('a cached key keeps working inside the TTL', async () => {
    const { id, secret } = await make();
    setPrincipalCacheTtl(60_000);
    expect(await resolvePrincipal(req(secret))).not.toBeNull();
    await adminDb.update(apiKey).set({ revokedAt: new Date() }).where(eq(apiKey.id, id));
    expect(await resolvePrincipal(req(secret))).not.toBeNull();
    setPrincipalCacheTtl(0);
    await expect(resolvePrincipal(req(secret))).rejects.toMatchObject({
      slug: 'key-revoked',
    });
  });

  it('fails for a suspended tenant', async () => {
    const admin = await seedUser({ admin: true });
    const o = await seedUser({ signedIn: true });
    const t = await createTenant(admin.actor, {
      slug: uniqueSlug(),
      name: 'S',
      currency: 'USD',
      timezone: 'UTC',
      ownerEmail: o.email,
    });
    const { secret } = await inTenant(t.tenantId, o.actor, (ctx) =>
      createApiKey(ctx, {
        name: 'k',
        environment: 'live',
        scopes: ['members:read'],
      }),
    );
    expect(await resolvePrincipal(req(secret))).not.toBeNull();
    await adminDb.update(tenant).set({ status: 'suspended' }).where(eq(tenant.id, t.tenantId));
    expect(await resolvePrincipal(req(secret))).toBeNull();
  });

  it('records last use at most once a minute', async () => {
    const { id, secret } = await make();
    await resolvePrincipal(req(secret, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }));
    const [a] = await adminDb.select().from(apiKey).where(eq(apiKey.id, id));
    expect(a!.lastUsedAt).not.toBeNull();
    expect(a!.lastUsedIp).toBe('203.0.113.7');
    await resolvePrincipal(req(secret, { 'x-forwarded-for': '198.51.100.9' }));
    const [b] = await adminDb.select().from(apiKey).where(eq(apiKey.id, id));
    expect(b!.lastUsedAt).toEqual(a!.lastUsedAt);
    expect(b!.lastUsedIp).toBe('203.0.113.7');
  });

  it('does not depend on the creator staying enabled (TEN-E2-S3-AC2)', async () => {
    const admin = await seedUser({ admin: true });
    const o = await seedUser({ signedIn: true });
    const t = await createTenant(admin.actor, {
      slug: uniqueSlug(),
      name: 'D',
      currency: 'USD',
      timezone: 'UTC',
      ownerEmail: o.email,
    });
    const { secret } = await inTenant(t.tenantId, o.actor, (ctx) =>
      createApiKey(ctx, {
        name: 'k',
        environment: 'live',
        scopes: ['members:read'],
      }),
    );
    await adminDb.execute(sql`update tenancy."user" set disabled_at = now() where id = ${o.id}`);
    expect(await resolvePrincipal(req(secret))).not.toBeNull();
  });
});

describe('createKeyFromCli', () => {
  it('creates a key for a tenant slug', async () => {
    const secret = await createKeyFromCli({
      tenantSlug: slug,
      name: 'cli',
      scopes: ['members:read'],
      test: true,
    });
    expect(secret).toMatch(/^scout_test_/);
    expect(await resolvePrincipal(req(secret))).toMatchObject({ tenantId });
  });
  it('rejects an unknown tenant', async () => {
    await expect(
      createKeyFromCli({
        tenantSlug: 'nope-nope',
        name: 'x',
        scopes: [],
        test: false,
      }),
    ).rejects.toMatchObject({ slug: 'not-found' });
  });
});
