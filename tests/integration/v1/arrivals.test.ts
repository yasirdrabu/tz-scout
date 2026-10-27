import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as listArrivalsRoute, POST as postArrival } from '@/app/v1/arrivals/route';
import { GET as getArrivalRoute } from '@/app/v1/arrivals/[id]/route';
import { GET as listSourcesRoute, POST as postSource } from '@/app/v1/sources/route';
import { registerSource, updateSource } from '@/modules/intake';
import { arrival } from '@/modules/intake/db/schema';
import { closeDbs } from '@/platform/db/client';
import { validArrival } from '../intake/helpers';
import { call, freshTenant, keyFor, personAndAgent, SEND, type Tenant } from './intake-helpers';

let t: Tenant;
let ash: { personId: string; agentId: string };
let bo: { personId: string; agentId: string };
let ashKey: string;
let boKey: string;

beforeAll(async () => {
  t = await freshTenant();
  ash = await personAndAgent(t, 'Ash');
  bo = await personAndAgent(t, 'Bo');
  ashKey = await keyFor(t, SEND, { sourceId: ash.agentId });
  boKey = await keyFor(t, SEND, { sourceId: bo.agentId });
});
afterAll(closeDbs);

const count = () => t.run(async (ctx) => (await ctx.tx.select({ id: arrival.id }).from(arrival)).length);
const post = (key: string, body: unknown, headers: Record<string, string> = {}) =>
  call(postArrival, key, 'arrivals', { body, headers });

describe('POST /v1/arrivals', () => {
  it('SRC-E2-S1-AC1: answers 202 with arrival_id and status_url', async () => {
    const res = await post(ashKey, validArrival());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.arrival_id).toMatch(/^arr_/);
    expect(body.status_url).toMatch(new RegExp(`/v1/arrivals/${body.arrival_id}$`));
    expect(body.duplicate_of_request).toBeUndefined();
  });

  it('API-E1-S2-AC1: the same Idempotency-Key creates one arrival', async () => {
    const body = validArrival();
    const before = await count();
    const first = await post(ashKey, body, { 'idempotency-key': 'k-one' });
    const second = await post(ashKey, body, { 'idempotency-key': 'k-one' });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect((await second.json()).arrival_id).toBe((await first.json()).arrival_id);
    expect(await count()).toBe(before + 1);
  });

  it('API-E1-S2-AC2: a repeated external_ref gets 200 with duplicate_of_request', async () => {
    const body = validArrival({ external_ref: 'dup-ref-1' });
    const first = await (await post(ashKey, body)).json();
    const again = await post(ashKey, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ arrival_id: first.arrival_id, duplicate_of_request: true });
  });

  it('SRC-E2-S1-AC4: an invalid body is a 400 with two error paths and stores nothing', async () => {
    const before = await count();
    const res = await post(ashKey, { account: { name: 'No identity', website: 'not a site', domain: 'nope' } });
    expect(res.status).toBe(400);
    const { errors } = await res.json();
    expect(errors.map((e: { path: string }) => e.path).sort()).toEqual(['account.domain', 'account.website']);
    expect(await count()).toBe(before);
  });

  it('refuses an unknown top-level field with a 400', async () => {
    const res = await post(ashKey, { ...validArrival(), surprise: 1 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('surprise');
  });

  it('SRC-E2-S1-AC6: over the daily cap is a 429 with Retry-After and resets_at', async () => {
    const capped = await t.run((ctx) => registerSource(ctx, { kind: 'agent', name: 'Capped', parentId: ash.personId }));
    await t.run((ctx) => updateSource(ctx, capped.id, { dailyArrivalCap: 1 }));
    const key = await keyFor(t, SEND, { sourceId: capped.id });
    expect((await post(key, validArrival())).status).toBe(202);
    const res = await post(key, validArrival());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ type: expect.stringContaining('cap-reached'), resets_at: expect.any(String) });
  });

  it('needs arrivals:write', async () => {
    const readOnly = await keyFor(t, ['arrivals:read']);
    expect((await post(readOnly, validArrival())).status).toBe(403);
  });
});

describe('GET /v1/arrivals', () => {
  it('returns { data, next_cursor }, filters by status and pages', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await (await post(boKey, validArrival())).json()).arrival_id);
    const p1 = await (await call(listArrivalsRoute, boKey, 'arrivals?limit=2')).json();
    expect(p1.data).toHaveLength(2);
    expect(p1.next_cursor).toEqual(expect.any(String));
    const p2 = await (await call(listArrivalsRoute, boKey, `arrivals?limit=2&cursor=${p1.next_cursor}`)).json();
    expect([...p1.data, ...p2.data].map((a: { id: string }) => a.id)).toEqual(expect.arrayContaining(ids));
    expect(p1.data[0]).toHaveProperty('received_at');
    const none = await (await call(listArrivalsRoute, boKey, 'arrivals?status=rejected')).json();
    expect(none.data).toEqual([]);
    expect((await call(listArrivalsRoute, boKey, 'arrivals?status=bogus')).status).toBe(400);
    expect((await call(listArrivalsRoute, boKey, 'arrivals?since=yesterday')).status).toBe(400);
  });
});

describe('GET /v1/arrivals/{id}', () => {
  it('shows an arrival to its own source and hides it from another with a 404', async () => {
    const { arrival_id } = await (await post(ashKey, validArrival())).json();
    const mine = await call(getArrivalRoute, ashKey, `arrivals/${arrival_id}`);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ id: arrival_id, status: 'received', source_chain: { agent_source_id: ash.agentId } });
    expect((await call(getArrivalRoute, boKey, `arrivals/${arrival_id}`)).status).toBe(404);
    expect((await call(getArrivalRoute, ashKey, 'arrivals/arr_missing')).status).toBe(404);
  });

  it('TEN-E3-S3-AC1: people contact fields are removed without people:read, at any depth', async () => {
    const body = {
      ...validArrival(),
      people: [{ name: 'Pat', title: 'CTO', email: 'pat@x.com', phone: '1', linkedin_url: 'https://linkedin.com/in/pat' }],
    };
    const { arrival_id } = await (await post(ashKey, body)).json();
    const without = await (await call(getArrivalRoute, ashKey, `arrivals/${arrival_id}`)).json();
    const text = JSON.stringify(without);
    for (const leaked of ['pat@x.com', 'linkedin.com/in/pat', '"phone"', '"email"']) expect(text).not.toContain(leaked);
    expect(text).toContain('CTO');

    const withRead = await keyFor(t, [...SEND, 'people:read'], { sourceId: ash.agentId });
    const full = JSON.stringify(await (await call(getArrivalRoute, withRead, `arrivals/${arrival_id}`)).json());
    expect(full).toContain('pat@x.com');
  });
});

describe('/v1/sources', () => {
  it('lists visible sources as { data, next_cursor } and creates one with sources:manage', async () => {
    const list = await (await call(listSourcesRoute, ashKey, 'sources')).json();
    const seen = list.data.map((s: { id: string }) => s.id);
    expect(seen).toContain(ash.agentId);
    expect(seen).not.toContain(bo.agentId);
    expect(list).toHaveProperty('next_cursor', null);
    expect(list.data[0]).toHaveProperty('daily_arrival_cap');

    const manage = await keyFor(t, ['sources:manage', 'arrivals:read']);
    const res = await call(postSource, manage, 'sources', { body: { kind: 'vendor', name: 'Acme Data' } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ kind: 'vendor', name: 'Acme Data', trust: 0.6 });
    const bad = await call(postSource, manage, 'sources', { body: { kind: 'agent', name: 'Orphan' } });
    expect(bad.status).toBe(400);
    expect((await call(postSource, ashKey, 'sources', { body: { kind: 'vendor', name: 'x' } })).status).toBe(403);
    expect((await call(postSource, manage, 'sources', { body: { kind: 'vendor', name: 'x', tenant_id: 'y' } })).status).toBe(400);
  });
});
