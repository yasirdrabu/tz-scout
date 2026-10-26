import { eq, sql } from 'drizzle-orm';
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
    expect((await connOf(t.tenantId)).status).toBe('not_set_up');
  });

  it('three consecutive live errors set failing; a later live success clears it', async () => {
    const t = await freshTenant();
    await t.run((ctx) => saveCredential(ctx, 'demo', { kind: 'api_key', value: 'good-token-50' }));
    await t.run((ctx) => testConnection(ctx, 'demo'));
    await t.run((ctx) => setMode(ctx, 'demo', 'live'));
    const boom = (): Promise<never> => Promise.reject(Object.assign(new Error('Upstream broke'), { status: 502 }));
    for (let i = 0; i < 3; i++) {
      await expect(t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.write', boom))).rejects.toThrow(
        'Upstream broke',
      );
      expect((await connOf(t.tenantId)).status).toBe(i < 2 ? 'connected' : 'failing');
    }
    const c = await connOf(t.tenantId);
    expect(c.consecutiveFailures).toBe(3);
    expect(c.lastError).toBe('Upstream broke');
    const rows = (await logs(t.tenantId)).filter((r) => r.operation === 'demo.thing.write');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.outcome === 'error' && r.statusCode === 502)).toBe(true);
    await t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.read', async () => 1));
    const after = await connOf(t.tenantId);
    expect(after.status).toBe('connected');
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastError).toBeNull();
  });

  it('calls on sample data never change the connection status or failure count', async () => {
    const t = await freshTenant();
    await t.run((ctx) => saveCredential(ctx, 'demo', { kind: 'api_key', value: 'never-tested-100' }));
    const before = await connOf(t.tenantId);
    expect(before.status).not.toBe('connected');
    await t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.read', async () => 1));
    expect((await connOf(t.tenantId)).status).toBe(before.status); // a sample-data success is not "connected"
    const boom = (): Promise<never> => Promise.reject(new Error('Mock broke'));
    for (let i = 0; i < 3; i++) {
      await expect(t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.write', boom))).rejects.toThrow('Mock broke');
    }
    const after = await connOf(t.tenantId);
    expect(after).toMatchObject({ status: before.status, consecutiveFailures: 0, lastError: before.lastError });
    expect((await logs(t.tenantId)).map((r) => r.outcome)).toEqual(['ok', 'error', 'error', 'error']);
  });

  it('sees a credential saved earlier in the same open transaction', async () => {
    const t = await freshTenant();
    const message = await t.run(async (ctx) => {
      await saveCredential(ctx, 'demo', { kind: 'api_key', value: 'good-token-200' });
      return (await testConnection(ctx, 'demo')).message;
    });
    expect(message).toBe('Connected to the demo service.');
  });

  it('removes the credential value from errors everywhere it is stored or rethrown', async () => {
    const t = await freshTenant();
    const value = 'Bearer sk-live-SECRET-12345';
    await t.run((ctx) => saveCredential(ctx, 'demo', { kind: 'api_key', value }));
    await t.run((ctx) => testConnection(ctx, 'demo'));
    await t.run((ctx) => setMode(ctx, 'demo', 'live'));
    const err = await t
      .run((ctx) =>
        gateway.call(ctx, 'demo', 'demo.thing.read', async () => {
          throw new Error('bad token ' + value + ' for sk-live-SECRET-12345');
        }),
      )
      .catch((e) => e as Error);
    expect(err.message).not.toContain('SECRET');
    expect(err.stack).not.toContain('SECRET');
    const rows = await logs(t.tenantId);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(JSON.stringify(await connOf(t.tenantId))).not.toContain('SECRET');
  });

  it('turns an unreadable credential into credential_unreadable and logs it', async () => {
    const t = await freshTenant();
    await t.run((ctx) => saveCredential(ctx, 'demo', { kind: 'api_key', value: 'good-token-300' }));
    await t.run((ctx) => testConnection(ctx, 'demo'));
    await t.run((ctx) => setMode(ctx, 'demo', 'live'));
    await adminDb.execute(sql`update integrations.credential set ciphertext = 'AAAA' where tenant_id = ${t.tenantId}`);
    await expect(t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.read', async () => 1))).rejects.toMatchObject({
      slug: 'credential_unreadable',
    });
    const rows = await logs(t.tenantId);
    expect(rows.filter((r) => r.outcome === 'error')).toHaveLength(1);
    // A test key never touches the credential, so it still works on the mock.
    await expect(
      t.run((ctx) => gateway.call({ ...ctx, environment: 'test' }, 'demo', 'demo.thing.read', async () => 1)),
    ).resolves.toBe(1);
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
    const which = (ctx: Parameters<typeof gateway.call>[0]) =>
      gateway.call(ctx, 'demo', 'demo.who', async (a: Adapter) => (await a.test()).message);

    expect(await t.run((ctx) => which(ctx))).toBe('Sample data is working.');
    await t.run((ctx) => setMode(ctx, 'demo', 'live'));
    expect(await t.run((ctx) => which(ctx))).toBe('Connected to the demo service.');
    expect(await t.run((ctx) => which({ ...ctx, environment: 'test' }))).toBe('Sample data is working.');
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
