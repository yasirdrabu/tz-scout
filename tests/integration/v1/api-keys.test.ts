import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 2 trusted proxy hops in front of Scout, so X-Forwarded-For is read.
vi.mock('@/platform/config', async (orig) => {
  const real = await orig<typeof import('@/platform/config')>();
  return { ...real, config: new Proxy(real.config, { get: (t, p) => (p === 'trustedProxyHops' ? 2 : (t as never)[p]) }) };
});
import { GET as listKeys, POST as createKey } from '@/http/routes/v1/api-keys/route';
import { DELETE as revokeKey } from '@/http/routes/v1/api-keys/[id]/route';
import { GET as listSourceKeys, POST as createSourceKey } from '@/http/routes/v1/sources/[id]/keys/route';
import { GET as me } from '@/http/routes/v1/me/route';
import { registerSource } from '@/modules/intake';
import { SYSTEM_GRANTOR, addMember, createApiKey, setPrincipalCacheTtl } from '@/modules/tenancy';
import { apiKey } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { inTenant, seedUser } from '../tenancy/helpers';
import { signedIn, tenantOwnedBy, v1Req, type Person, type ReqOpts } from './session-helpers';

let owner: Person;
let leader: Person;
let operator: Person;
let t: { tenantId: string; slug: string };
let sourceA: string;
let sourceB: string;
const cookies: Record<string, Headers> = {};

beforeAll(async () => {
  const admin = await seedUser({ admin: true, signedIn: true });
  owner = await seedUser({ signedIn: true });
  leader = await seedUser({ signedIn: true });
  operator = await seedUser({ signedIn: true });
  t = await tenantOwnedBy(admin, owner.email);
  await inTenant(t.tenantId, owner.actor, async (ctx) => {
    await addMember(ctx, { email: leader.email, role: 'leader' });
    await addMember(ctx, { email: operator.email, role: 'operator' });
    sourceA = (await registerSource(ctx, { kind: 'person', name: 'Clay agent' })).id;
    sourceB = (await registerSource(ctx, { kind: 'agent', name: 'Partner agent', parentId: sourceA })).id;
  });
  for (const p of [owner, leader, operator]) cookies[p.id] = await signedIn(p.id);
});
beforeEach(() => setPrincipalCacheTtl(0));

const as = (p: Person, path: string, opts: Omit<ReqOpts, 'cookies' | 'tenant'> = {}) =>
  v1Req(path, { ...opts, cookies: cookies[p.id], tenant: t.slug });

describe('/v1/api-keys (keys:manage)', () => {
  it('creates a key from an access choice, returns the secret once, and lists it masked with names', async () => {
    const res = await createKey(
      as(owner, '/api-keys', { method: 'POST', body: { name: 'Clay', source_id: sourceA, access: 'send_and_status' }, headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } }),
    );
    expect(res.status).toBe(201);
    const made = await res.json();
    expect(made).toMatchObject({
      id: expect.stringMatching(/^key_/),
      name: 'Clay',
      secret: expect.stringMatching(/^scout_live_[0-9A-Za-z]{32}$/),
      scopes: ['arrivals:write', 'arrivals:read', 'status:read'],
      source_id: sourceA,
      created_by: owner.id,
    });
    expect(made.mask).toBe(`${made.prefix}…`);
    expect(made.secret.startsWith(made.prefix)).toBe(true);

    // The key works.
    const who = await me(new Request('http://x/v1/me', { headers: { authorization: `Bearer ${made.secret}` } }));
    expect((await who.json()).source_id).toBe(sourceA);

    const list = await listKeys(as(owner, '/api-keys'));
    expect(list.status).toBe(200);
    const row = (await list.json()).data.find((k: { id: string }) => k.id === made.id);
    expect(row).toMatchObject({ name: 'Clay', mask: made.mask, source_name: 'Clay agent', created_by_name: owner.email.split('@')[0], revoked_at: null });
    expect(row.secret).toBeUndefined();

    // New audit entries record the caller's IP.
    const [entry] = await adminDb.select().from(auditLog).where(and(eq(auditLog.subjectId, made.id), eq(auditLog.action, 'tenancy.api_key.created')));
    expect(entry!.ip).toBe('203.0.113.9');
  });

  it('filters by source', async () => {
    await createKey(as(owner, '/api-keys', { method: 'POST', body: { name: 'Partner', source_id: sourceB, access: 'send_only' } }));
    const data = (await (await listKeys(as(owner, `/api-keys?source_id=${sourceB}`))).json()).data;
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((k: { source_id: string }) => k.source_id === sourceB)).toBe(true);
  });

  it('refuses people without keys:manage and API keys', async () => {
    expect((await listKeys(as(leader, '/api-keys'))).status).toBe(403);
    expect((await createKey(as(operator, '/api-keys', { method: 'POST', body: { name: 'x', source_id: sourceA, access: 'send_only' } }))).status).toBe(403);
    const { secret } = await inTenant(t.tenantId, owner.actor, (ctx) =>
      createApiKey(ctx, { name: 'admin key', environment: 'live', scopes: ['keys:manage'] }, SYSTEM_GRANTOR),
    );
    const res = await createKey(
      new Request('http://x/v1/api-keys', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x', source_id: sourceA, access: 'send_only' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('refuses an unknown access choice, a missing source and an unknown source', async () => {
    const bad = await createKey(as(owner, '/api-keys', { method: 'POST', body: { name: 'x', source_id: sourceA, access: 'everything' } }));
    expect(bad.status).toBe(400);
    expect((await createKey(as(owner, '/api-keys', { method: 'POST', body: { name: 'x', access: 'send_only' } }))).status).toBe(400);
    const unknown = await createKey(as(owner, '/api-keys', { method: 'POST', body: { name: 'x', source_id: 'src_nope', access: 'read_only' } }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).type).toMatch(/\/source-not-found$/);
  });

  it('revokes a key with DELETE; calls with it then fail', async () => {
    const made = await (await createKey(as(owner, '/api-keys', { method: 'POST', body: { name: 'Temp', source_id: sourceA, access: 'read_only' } }))).json();
    expect((await revokeKey(as(leader, `/api-keys/${made.id}`, { method: 'DELETE' }))).status).toBe(403);
    const res = await revokeKey(as(owner, `/api-keys/${made.id}`, { method: 'DELETE' }));
    expect(res.status).toBe(204);
    const [row] = await adminDb.select().from(apiKey).where(eq(apiKey.id, made.id));
    expect(row!.revokedAt).not.toBeNull();
    const who = await me(new Request('http://x/v1/me', { headers: { authorization: `Bearer ${made.secret}` } }));
    expect(who.status).toBe(401);
    expect((await revokeKey(as(owner, `/api-keys/${made.id}`, { method: 'DELETE' }))).status).toBe(404);
  });
});

describe('/v1/sources/{id}/keys (sources:manage)', () => {
  it("lets an operator make and list that source's keys only", async () => {
    const res = await createSourceKey(as(operator, `/sources/${sourceB}/keys`, { method: 'POST', body: { name: 'Agent key' } }));
    expect(res.status).toBe(201);
    const made = await res.json();
    expect(made).toMatchObject({ source_id: sourceB, scopes: ['arrivals:write', 'arrivals:read', 'status:read'], secret: expect.any(String) });
    const data = (await (await listSourceKeys(as(operator, `/sources/${sourceB}/keys`))).json()).data;
    expect(data.map((k: { id: string }) => k.id)).toContain(made.id);
    expect(data.every((k: { source_id: string }) => k.source_id === sourceB)).toBe(true);
    expect(data.every((k: { secret?: string }) => k.secret === undefined)).toBe(true);
  });

  it('refuses without sources:manage, an unknown source and a bad body', async () => {
    const seller = await seedUser({ signedIn: true });
    await inTenant(t.tenantId, owner.actor, (ctx) => addMember(ctx, { email: seller.email, role: 'seller' }));
    cookies[seller.id] = await signedIn(seller.id);
    expect((await listSourceKeys(as(seller, `/sources/${sourceA}/keys`))).status).toBe(403);
    expect((await listSourceKeys(as(operator, '/sources/src_nope/keys'))).status).toBe(404);
    expect((await createSourceKey(as(operator, `/sources/${sourceA}/keys`, { method: 'POST', body: { name: 'x', scopes: ['keys:manage'] } }))).status).toBe(400);
  });
});

describe('the secret is never stored for an Idempotency-Key', () => {
  const storedWith = async (secret: string) =>
    (await adminDb.execute(sql`select 1 from platform.idempotency_key where response_body::text like ${`%${secret}%`}`)).length;

  it('POST /v1/api-keys keeps no stored response with the secret, and a repeat does not hand it out again', async () => {
    const send = () =>
      createKey(as(owner, '/api-keys', { method: 'POST', body: { name: 'Once', source_id: sourceA, access: 'read_only' }, headers: { 'idempotency-key': `once-${Date.now()}` } }));
    const first = await (await send()).json();
    expect(await storedWith(first.secret)).toBe(0);
    const again = await send();
    expect(again.headers.get('idempotent-replayed')).toBeNull();
    expect((await again.json()).secret).not.toBe(first.secret);
  });

  it('POST /v1/sources/{id}/keys likewise', async () => {
    const key = `src-once-${Date.now()}`;
    const send = () => createSourceKey(as(operator, `/sources/${sourceA}/keys`, { method: 'POST', body: { name: 'Once' }, headers: { 'idempotency-key': key } }));
    const first = await (await send()).json();
    expect(await storedWith(first.secret)).toBe(0);
    expect((await (await send()).json()).secret).not.toBe(first.secret);
  });
});

describe("another tenant's keys and sources are not found and left alone", () => {
  it('DELETE /v1/api-keys/{id} and /v1/sources/{id}/keys answer 404', async () => {
    const admin = await seedUser({ admin: true });
    const o = await seedUser({ signedIn: true });
    const t2 = await tenantOwnedBy(admin, o.email, 'Other Co');
    const { keyId, sourceId } = await inTenant(t2.tenantId, o.actor, async (ctx) => {
      const s = await registerSource(ctx, { kind: 'person', name: 'Theirs' });
      const k = await createApiKey(ctx, { name: 'theirs', environment: 'live', scopes: ['status:read'], sourceId: s.id }, SYSTEM_GRANTOR);
      return { keyId: k.id, sourceId: s.id };
    });
    expect((await revokeKey(as(owner, `/api-keys/${keyId}`, { method: 'DELETE' }))).status).toBe(404);
    expect((await listSourceKeys(as(operator, `/sources/${sourceId}/keys`))).status).toBe(404);
    expect((await createSourceKey(as(operator, `/sources/${sourceId}/keys`, { method: 'POST', body: { name: 'sneaky' } }))).status).toBe(404);
    const theirs = await adminDb.select().from(apiKey).where(eq(apiKey.sourceId, sourceId));
    expect(theirs.map((k) => [k.id, k.revokedAt])).toEqual([[keyId, null]]);
  });
});
