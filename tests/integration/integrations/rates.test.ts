import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/config', async (orig) => {
  const real = await orig<typeof import('@/platform/config')>();
  const { cfg } = await import('./cfg');
  const over = cfg as Record<string, unknown>;
  return {
    ...real,
    config: new Proxy(real.config, {
      get: (t, p) => (over[p as string] !== undefined ? over[p as string] : (t as never)[p]),
    }),
  };
});

import { GET as getRatesRoute, PUT as putRatesRoute } from '@/http/routes/v1/integrations/[key]/rates/route';
import {
  gateway,
  getRates,
  priceCents,
  saveCredential,
  setConnectionSettings,
  setMode,
  setRates,
  testConnection,
} from '@/modules/integrations';
import { callLog } from '@/modules/integrations/db/schema';
import { addMember, setPrincipalCacheTtl } from '@/modules/tenancy';
import { adminDb } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { cfg } from './cfg';
import { freshTenant, newKey } from './helpers';
import { inTenant, seedUser } from '../tenancy/helpers';
import { signedIn, tenantOwnedBy, v1Req, type Person, type ReqOpts } from '../v1/session-helpers';

beforeAll(() => {
  cfg.masterKey = newKey();
});
beforeEach(() => setPrincipalCacheTtl(0));

type T = Awaited<ReturnType<typeof freshTenant>>;

const usageEvents = async (tenantId: string) =>
  (
    await adminDb
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(sql`${outbox.tenantId} = ${tenantId} and ${outbox.payload}->>'type' = 'integrations.usage.recorded'`)
  ).map((r) => r.payload as { schemaVersion: number; correlationId: string; data: Record<string, unknown> });
const logs = (tenantId: string) => adminDb.select().from(callLog).where(eq(callLog.tenantId, tenantId)).orderBy(callLog.at);

async function demoLive(t: T) {
  await t.run((ctx) => saveCredential(ctx, 'demo', { kind: 'api_key', value: 'good-token-rates' }));
  await t.run((ctx) => testConnection(ctx, 'demo'));
  await t.run((ctx) => setMode(ctx, 'demo', 'live'));
}

describe('rates and priceCents (Rulings 1 and 2)', () => {
  it('with no rows uses the defaults: Claude per token from the list prices, Apollo 10 cents a credit', async () => {
    const t = await freshTenant();
    const claude = await t.run((ctx) => getRates(ctx, 'anthropic'));
    expect(claude).toContainEqual({ item: 'claude-sonnet-5-5:input', centsPerUnit: 0.0003, isDefault: true });
    expect(claude).toContainEqual({ item: 'claude-sonnet-5-5:output', centsPerUnit: 0.0015, isDefault: true });
    expect(await t.run((ctx) => getRates(ctx, 'apollo'))).toEqual([{ item: 'credit', centsPerUnit: 10, isDefault: true }]);
    expect(await t.run((ctx) => getRates(ctx, 'hubspot'))).toEqual([]);
    expect(await t.run((ctx) => priceCents(ctx, 'apollo', [{ item: 'credit', units: 3 }]))).toBe(30);
    expect(await t.run((ctx) => priceCents(ctx, 'anthropic', [{ item: 'claude-sonnet-5-5:input', units: 1500 }]))).toBe(0);
    expect(await t.run((ctx) => priceCents(ctx, 'anthropic', [{ item: 'claude-sonnet-5-5:input', units: 2_000_000 }]))).toBe(600);
  });

  it("the connection's cents per credit is the default when set", async () => {
    const t = await freshTenant();
    await t.run((ctx) => setConnectionSettings(ctx, 'vibe', { cents_per_credit: 7 }));
    expect(await t.run((ctx) => getRates(ctx, 'vibe'))).toEqual([{ item: 'credit', centsPerUnit: 7, isDefault: true }]);
  });

  it('a saved rate wins over the default', async () => {
    const t = await freshTenant();
    await t.run((ctx) => setRates(ctx, 'apollo', [{ item: 'credit', centsPerUnit: 12.5 }]));
    await t.run((ctx) => setRates(ctx, 'anthropic', [{ item: 'claude-haiku-5-5:output', centsPerUnit: 0.001 }]));
    expect(await t.run((ctx) => getRates(ctx, 'apollo'))).toEqual([{ item: 'credit', centsPerUnit: 12.5, isDefault: false }]);
    expect(await t.run((ctx) => priceCents(ctx, 'apollo', [{ item: 'credit', units: 3 }]))).toBe(38);
    const claude = await t.run((ctx) => getRates(ctx, 'anthropic'));
    expect(claude).toContainEqual({ item: 'claude-haiku-5-5:output', centsPerUnit: 0.001, isDefault: false });
    expect(claude).toContainEqual({ item: 'claude-haiku-5-5:input', centsPerUnit: 0.0001, isDefault: true });
  });

  it('refuses a negative rate and an item the provider is not priced by', async () => {
    const t = await freshTenant();
    await expect(t.run((ctx) => setRates(ctx, 'apollo', [{ item: 'credit', centsPerUnit: -1 }]))).rejects.toMatchObject({
      status: 400,
      message: "A rate can't be negative.",
    });
    await expect(t.run((ctx) => setRates(ctx, 'apollo', [{ item: 'nope', centsPerUnit: 1 }]))).rejects.toMatchObject({ status: 400 });
  });
});

describe('integrations.usage.recorded (Ruling 3)', () => {
  it('a live priced call publishes one event with the payload', async () => {
    const t = await freshTenant();
    await demoLive(t);
    let correlationId = '';
    await t.run((ctx) => {
      correlationId = ctx.correlationId;
      return gateway.call(ctx, 'demo', 'demo.thing.read', async () => 'ok', {
        module: 'enrichment',
        units: 3,
        unit: 'credits',
        costCents: 30,
        accountId: 'acc_1',
      });
    });
    const [row] = (await logs(t.tenantId)).filter((r) => r.operation === 'demo.thing.read');
    const events = await usageEvents(t.tenantId);
    expect(events).toHaveLength(1);
    expect(events[0]!.schemaVersion).toBe(1);
    expect(events[0]!.data).toEqual({
      callId: row!.id,
      provider: 'demo',
      operation: 'demo.thing.read',
      module: 'enrichment',
      units: 3,
      unit: 'credits',
      costCents: 30,
      accountId: 'acc_1',
      correlationId,
      occurredAt: expect.any(String),
    });
  });

  it('the cost from measure is the one published; no account is null', async () => {
    const t = await freshTenant();
    await demoLive(t);
    await t.run((ctx) =>
      gateway.call(ctx, 'demo', 'demo.thing.read', async () => 'ok', { unit: 'tokens', measure: () => ({ units: 10, costCents: 4 }) }),
    );
    const [e] = await usageEvents(t.tenantId);
    expect(e!.data).toMatchObject({ units: 10, unit: 'tokens', costCents: 4, accountId: null, module: null });
  });

  it('a mock call, a free call and a failed call publish nothing (Review Focus 4)', async () => {
    const t = await freshTenant();
    await t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.read', async () => 'ok', { costCents: 30 }));
    await demoLive(t);
    await t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.read', async () => 'ok', { costCents: 0 }));
    await t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.read', async () => 'ok'));
    await expect(
      t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.read', () => Promise.reject(new Error('Upstream broke')), { costCents: 30 })),
    ).rejects.toThrow('Upstream broke');
    expect(await usageEvents(t.tenantId)).toHaveLength(0);
  });

  it('measure is told whether the call was live', async () => {
    const t = await freshTenant();
    const seen: boolean[] = [];
    const measure = (_r: never, call: { live: boolean }) => {
      seen.push(call.live);
      return {};
    };
    await t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.read', async () => 'ok', { measure }));
    await demoLive(t);
    await t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.read', async () => 'ok', { measure }));
    expect(seen).toEqual([false, true]);
  });
});

describe('GET and PUT /api/v1/integrations/{key}/rates', () => {
  let owner: Person;
  let leader: Person;
  let w: { tenantId: string; slug: string };
  const cookies: Record<string, Headers> = {};

  beforeAll(async () => {
    const admin = await seedUser({ admin: true, signedIn: true });
    owner = await seedUser({ signedIn: true });
    leader = await seedUser({ signedIn: true });
    w = await tenantOwnedBy(admin, owner.email);
    await inTenant(w.tenantId, owner.actor, (ctx) => addMember(ctx, { email: leader.email, role: 'leader' }));
    for (const p of [owner, leader]) cookies[p.id] = await signedIn(p.id);
  });
  const as = (p: Person, path: string, opts: Omit<ReqOpts, 'cookies' | 'tenant'> = {}) =>
    v1Req(path, { ...opts, cookies: cookies[p.id], tenant: w.slug });
  const put = (p: Person, key: string, rates: unknown) =>
    putRatesRoute(as(p, `/integrations/${key}/rates`, { method: 'PUT', body: { rates } }));

  it('round-trips the rates', async () => {
    const res = await put(owner, 'apollo', [{ item: 'credit', cents_per_unit: 12.5 }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: [{ item: 'credit', cents_per_unit: 12.5, is_default: false }] });
    const got = await getRatesRoute(as(owner, '/integrations/apollo/rates'));
    expect(got.status).toBe(200);
    expect((await got.json()).data).toEqual([{ item: 'credit', cents_per_unit: 12.5, is_default: false }]);
    const claude = (await (await getRatesRoute(as(owner, '/integrations/anthropic/rates'))).json()).data;
    expect(claude).toContainEqual({ item: 'claude-opus-5-5:input', cents_per_unit: 0.0015, is_default: true });
  });

  it('400s a negative rate, 404s an unknown service', async () => {
    const res = await put(owner, 'apollo', [{ item: 'credit', cents_per_unit: -0.5 }]);
    expect(res.status).toBe(400);
    expect((await res.json()).title).toBe("A rate can't be negative.");
    expect((await put(owner, 'apollo', [{ item: 'credit' }])).status).toBe(400);
    expect((await put(owner, 'nope', [{ item: 'credit', cents_per_unit: 1 }])).status).toBe(404);
  });

  it('refuses a leader without integrations:manage', async () => {
    expect((await put(leader, 'apollo', [{ item: 'credit', cents_per_unit: 1 }])).status).toBe(403);
    expect((await getRatesRoute(as(leader, '/integrations/apollo/rates'))).status).toBe(403);
  });
});
