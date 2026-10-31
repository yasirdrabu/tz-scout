import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 1 trusted proxy hop in front of Scout, so X-Forwarded-For is read.
vi.mock('@/platform/config', async (orig) => {
  const real = await orig<typeof import('@/platform/config')>();
  return { ...real, config: new Proxy(real.config, { get: (t, p) => (p === 'trustedProxyHops' ? 1 : (t as never)[p]) }) };
});
import { GET as listAuditRoute } from '@/http/routes/v1/audit/route';
import { POST as invite } from '@/http/routes/v1/members/route';
import { SYSTEM_GRANTOR, addMember, createApiKey, setPrincipalCacheTtl } from '@/modules/tenancy';
import { sql } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { inTenant, seedUser } from '../tenancy/helpers';
import { signedIn, tenantOwnedBy, v1Req, type Person } from './session-helpers';

let owner: Person;
let leader: Person;
let t: { tenantId: string; slug: string };
let keyId: string;
const cookies: Record<string, Headers> = {};

beforeAll(async () => {
  const admin = await seedUser({ admin: true, signedIn: true });
  owner = await seedUser({ email: `olive-${Date.now()}@example.com`, signedIn: true });
  leader = await seedUser({ signedIn: true });
  t = await tenantOwnedBy(admin, owner.email);
  await inTenant(t.tenantId, owner.actor, (ctx) => addMember(ctx, { email: leader.email, role: 'leader' }));
  for (const p of [owner, leader]) cookies[p.id] = await signedIn(p.id);
  // Through the API, so the IP is recorded.
  const res = await invite(
    v1Req('/members', {
      cookies: cookies[owner.id],
      tenant: t.slug,
      method: 'POST',
      body: { emails: ['audited@example.com'], role: 'seller' },
      headers: { 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }, // the client forged 6.6.6.6
    }),
  );
  expect(res.status).toBe(200);
  keyId = (await inTenant(t.tenantId, owner.actor, (ctx) => createApiKey(ctx, { name: 'Clay key', environment: 'live', scopes: [] }, SYSTEM_GRANTOR))).id;
  await inTenant(t.tenantId, { kind: 'agent', id: keyId }, (ctx) =>
    audit(ctx, { action: 'intake.arrival.skip', subject: { type: 'arrival', id: 'arr_100%' }, apiKeyId: keyId }),
  );
});
beforeEach(() => setPrincipalCacheTtl(0));

const get = async (query: string, as: Person = owner) => {
  const res = await listAuditRoute(v1Req(`/audit${query}`, { cookies: cookies[as.id], tenant: t.slug }));
  return { status: res.status, body: await res.json() };
};

describe('GET /v1/audit', () => {
  it('lists entries newest first with area, names and the IP of entries made through the API', async () => {
    const { status, body } = await get('');
    expect(status).toBe(200);
    const actions = body.data.map((e: { action: string }) => e.action);
    expect(actions[0]).toBe('intake.arrival.skip');
    const added = body.data.find((e: { action: string; after: { email?: string } }) => e.action === 'tenancy.member.added' && e.after.email === 'audited@example.com');
    expect(added).toMatchObject({ area: 'members', actor_kind: 'user', actor_id: owner.id, actor_name: owner.email.split('@')[0], ip: '198.51.100.7' });
    const skip = body.data[0];
    expect(skip).toMatchObject({ area: 'other', actor_kind: 'agent', actor_name: 'Clay key', api_key_name: 'Clay key' });
  });

  it('filters by area', async () => {
    const members = (await get('?area=members')).body.data;
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((e: { area: string }) => e.area === 'members')).toBe(true);
    const keys = (await get('?area=api_keys')).body.data;
    expect(keys.map((e: { action: string }) => e.action)).toEqual(['tenancy.api_key.created']);
    const other = (await get('?area=other')).body.data;
    expect(other.map((e: { action: string }) => e.action)).toEqual(['intake.arrival.skip']);
  });

  it('searches actions, targets and people or keys by name, with wildcards taken literally', async () => {
    const byPerson = (await get(`?q=${encodeURIComponent('OLIVE-')}`)).body.data;
    expect(byPerson.length).toBeGreaterThan(0);
    expect(byPerson.every((e: { actor_id: string }) => e.actor_id === owner.id)).toBe(true);
    expect((await get('?q=clay')).body.data.map((e: { action: string }) => e.action)).toEqual(['intake.arrival.skip']);
    expect((await get('?q=api_key.created')).body.data).toHaveLength(1);
    expect((await get(`?q=${encodeURIComponent('100%')}`)).body.data).toHaveLength(1);
    expect((await get(`?q=${encodeURIComponent('%')}`)).body.data).toHaveLength(1);
  });

  it('finds a member of this tenant by name', async () => {
    const tag = `quentin${Date.now()}`;
    const q = await seedUser({ email: `${tag}@example.com`, signedIn: true });
    await inTenant(t.tenantId, owner.actor, (ctx) => addMember(ctx, { email: q.email, role: 'leader' }));
    await inTenant(t.tenantId, q.actor, (ctx) => audit(ctx, { action: 'routing.settings.updated' }));
    const found = (await get(`?q=${tag.toUpperCase()}`)).body.data;
    expect(found.map((e: { actor_id: string; action: string }) => [e.actor_id, e.action])).toEqual([[q.id, 'routing.settings.updated']]);
    expect(found[0].actor_name).toBe(tag);
  });

  it('does not find a person who is not a member here, even when their name matches', async () => {
    const tag = `rupert${Date.now()}`;
    const stranger = await seedUser({ email: `${tag}@example.com`, signedIn: true });
    const elsewhere = await tenantOwnedBy(await seedUser({ admin: true }), stranger.email, 'Elsewhere Co');
    await inTenant(elsewhere.tenantId, stranger.actor, (ctx) => audit(ctx, { action: 'routing.settings.updated' }));
    // An entry here under their id, so only the membership rule can keep it out.
    await inTenant(t.tenantId, stranger.actor, (ctx) => audit(ctx, { action: 'routing.settings.updated' }));
    expect((await get(`?q=${tag}`)).body.data).toEqual([]);
    // The entry is there; it is only the name search that does not reach it.
    expect((await get(`?actor_id=${stranger.id}`)).body.data).toHaveLength(1);
  });

  it('pages through entries with equal and sub-millisecond times without losing or repeating any', async () => {
    const who = newId('usr');
    const times = ['2026-01-01 00:00:00.000300+00', '2026-01-01 00:00:00.000300+00', '2026-01-01 00:00:00.000200+00', '2026-01-01 00:00:00.000100+00', '2026-01-01 00:00:00+00'];
    await adminDb.insert(auditLog).values(
      times.map((at) => ({ id: newId('aud'), tenantId: t.tenantId, actorKind: 'user', actorId: who, action: 'routing.settings.updated', at: sql`${at}::timestamptz` })),
    );
    const all = (await get(`?actor_id=${who}`)).body.data.map((e: { id: string }) => e.id);
    expect(all).toHaveLength(5);
    const paged: string[] = [];
    let cursor = '';
    for (let i = 0; i < 6; i++) {
      const page = (await get(`?actor_id=${who}&limit=2${cursor ? `&cursor=${cursor}` : ''}`)).body;
      paged.push(...page.data.map((e: { id: string }) => e.id));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    expect(paged).toEqual(all);
  });

  it('filters by who and pages with a cursor', async () => {
    const mine = (await get(`?actor_id=${owner.id}`)).body.data;
    expect(mine.length).toBeGreaterThan(1);
    expect(mine.every((e: { actor_id: string }) => e.actor_id === owner.id)).toBe(true);
    const first = (await get(`?actor_id=${owner.id}&limit=1`)).body;
    expect(first.data).toHaveLength(1);
    const second = (await get(`?actor_id=${owner.id}&limit=1&cursor=${first.next_cursor}`)).body;
    expect(second.data[0].id).toBe(mine[1].id);
  });

  it('refuses a leader (no audit:read), an unknown area and a bad cursor', async () => {
    expect((await get('', leader)).status).toBe(403);
    expect((await get('?area=weather')).status).toBe(400);
    expect((await get('?cursor=nope')).status).toBe(400);
  });
});
