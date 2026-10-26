import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

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

import {
  RateLimitedError,
  gateway,
  redactSummary,
  saveCredential,
  setDisabled,
  setMode,
  testConnection,
  type Adapter,
} from '@/modules/integrations';
import { callLog, connection } from '@/modules/integrations/db/schema';
import { adminDb } from '@/platform/db/client';
import { cfg } from './cfg';
import { freshTenant, newKey } from './helpers';

beforeAll(() => {
  cfg.masterKey = newKey();
});

const logs = (tenantId: string) =>
  adminDb.select().from(callLog).where(eq(callLog.tenantId, tenantId)).orderBy(callLog.at);
const connOf = async (tenantId: string) =>
  (await adminDb.select().from(connection).where(eq(connection.tenantId, tenantId)))[0]!;

describe('gateway.call', () => {
  it('fails fast on a disabled connection with connection_disabled and does not run the function', async () => {
    const t = await freshTenant();
    await t.run((ctx) => setDisabled(ctx, 'demo', true));
    const fn = vi.fn(async () => 1);
    await expect(t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.read', fn))).rejects.toMatchObject({
      slug: 'connection_disabled',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('logs every call with the operation, even when the caller rolls back', async () => {
    const t = await freshTenant();
    let result: string | undefined;
    await t
      .run(async (ctx) => {
        result = await gateway.call(ctx, 'demo', 'demo.thing.read', async () => 'hello', {
          units: 3,
          unit: 'records',
          costCents: 7,
          module: 'enrichment',
          requestSummary: { count: 2, email: 'a@b.com', nested: { apiKey: 'x', recordId: 'r1' } },
        });
        throw new Error('rollback');
      })
      .catch(() => undefined);
    expect(result).toBe('hello');
    const rows = await logs(t.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: 'demo.thing.read',
      outcome: 'ok',
      provider: 'demo',
      units: 3,
      unit: 'records',
      costCents: 7,
      module: 'enrichment',
      requestSummary: { count: 2, nested: { recordId: 'r1' } },
    });
    expect(rows[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect((await connOf(t.tenantId)).status).toBe('connected');
  });

  it('three consecutive errors set failing; a success sets connected again', async () => {
    const t = await freshTenant();
    const boom = (): Promise<never> => Promise.reject(Object.assign(new Error('Upstream broke'), { status: 502 }));
    for (let i = 0; i < 3; i++) {
      await expect(t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.write', boom))).rejects.toThrow(
        'Upstream broke',
      );
      expect((await connOf(t.tenantId)).status).toBe(i < 2 ? 'not_set_up' : 'failing');
    }
    const c = await connOf(t.tenantId);
    expect(c.consecutiveFailures).toBe(3);
    expect(c.lastError).toBe('Upstream broke');
    const rows = await logs(t.tenantId);
    expect(rows).toHaveLength(3);
    expect(
      rows.every((r) => r.outcome === 'error' && r.operation === 'demo.thing.write' && r.statusCode === 502),
    ).toBe(true);
    await t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.read', async () => 1));
    const after = await connOf(t.tenantId);
    expect(after.status).toBe('connected');
    expect(after.consecutiveFailures).toBe(0);
  });

  it('logs rate limits as rate_limited without counting a failure', async () => {
    const t = await freshTenant();
    await expect(
      t.run((ctx) =>
        gateway.call(ctx, 'demo', 'demo.thing.read', async () => {
          throw new RateLimitedError();
        }),
      ),
    ).rejects.toBeInstanceOf(RateLimitedError);
    const [row] = await logs(t.tenantId);
    expect(row).toMatchObject({ outcome: 'rate_limited', statusCode: 429 });
    expect((await connOf(t.tenantId)).consecutiveFailures).toBe(0);
  });

  it('trims long error messages to 500 characters', async () => {
    const t = await freshTenant();
    await expect(
      t.run((ctx) =>
        gateway.call(ctx, 'demo', 'demo.x', async () => {
          throw new Error('x'.repeat(900));
        }),
      ),
    ).rejects.toThrow();
    expect((await logs(t.tenantId))[0]!.errorMessage).toHaveLength(500);
  });

  it('picks the mock for mock mode, test keys and force-mock; the live adapter in live mode', async () => {
    const t = await freshTenant();
    await t.run((ctx) => saveCredential(ctx, 'demo', { kind: 'api_key', value: 'good-token-9' }));
    await t.run((ctx) => testConnection(ctx, 'demo'));
    const which = (ctx: Parameters<typeof gateway.call>[0], opts?: Parameters<typeof gateway.call>[4]) =>
      gateway.call(ctx, 'demo', 'demo.who', async (a: Adapter) => (await a.test()).message, opts);

    expect(await t.run((ctx) => which(ctx))).toBe('Sample data is working.');
    await t.run((ctx) => setMode(ctx, 'demo', 'live'));
    expect(await t.run((ctx) => which(ctx))).toBe('Connected to the demo service.');
    expect(await t.run((ctx) => which(ctx, { principal: { environment: 'test' } }))).toBe('Sample data is working.');
    cfg.forceMock = true;
    try {
      expect(await t.run((ctx) => which(ctx))).toBe('Sample data is working.');
    } finally {
      cfg.forceMock = false;
    }
  });

  it('logs the connection test through the gateway', async () => {
    const t = await freshTenant();
    await t.run((ctx) => testConnection(ctx, 'demo'));
    expect((await logs(t.tenantId)).map((r) => r.operation)).toEqual(['demo.test']);
  });

  it('rejects an unknown provider', async () => {
    const t = await freshTenant();
    await expect(t.run((ctx) => gateway.call(ctx, 'nope', 'x', async () => 1))).rejects.toMatchObject({
      slug: 'unknown-provider',
    });
  });
});

describe('redactSummary', () => {
  it('drops secrets and personal data at any depth', () => {
    expect(
      redactSummary({
        n: 1,
        Authorization: 'x',
        phone: '1',
        list: [{ client_secret: 's', id: 'a' }],
        password: 'p',
        apiToken: 't',
      }),
    ).toEqual({ n: 1, list: [{ id: 'a' }] });
  });
});
