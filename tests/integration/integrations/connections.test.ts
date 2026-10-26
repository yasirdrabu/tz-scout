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
  MASTER_KEY_MISSING,
  credentialsCleanupHandler,
  listConnections,
  saveCredential,
  setDisabled,
  setMode,
  testConnection,
} from '@/modules/integrations';
import { connection, credential } from '@/modules/integrations/db/schema';
import { adminDb } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { cfg } from './cfg';
import { freshTenant, newKey } from './helpers';

const events = async (tenantId: string, type: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, tenantId))).filter(
    (r) => (r.payload as { type: string }).type === type,
  );

beforeAll(() => {
  cfg.masterKey = newKey();
  cfg.forceMock = false;
});

describe('listConnections', () => {
  it('returns all 15 providers as mock and not set up for a fresh tenant, without demo', async () => {
    const t = await freshTenant();
    const list = await t.run((ctx) => listConnections(ctx));
    expect(list).toHaveLength(15);
    expect(list.every((c) => c.mode === 'mock' && c.status === 'not_set_up')).toBe(true);
    expect(list.map((c) => c.provider)).not.toContain('demo');
    expect(list.map((c) => c.provider)).toContain('hubspot');
  });
});

describe('saveCredential', () => {
  it('keeps only the hint readable', async () => {
    const t = await freshTenant();
    const r = await t.run((ctx) => saveCredential(ctx, 'demo', { kind: 'private_app_token', value: 'pat-abc-1234' }));
    expect(r.hint).toBe('1234');
    const rows = await adminDb.select().from(credential).where(eq(credential.tenantId, t.tenantId));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('pat-abc');
    expect(rows[0]!.hint).toBe('1234');
  });

  it('shows the hint in the list', async () => {
    const t = await freshTenant();
    await t.run((ctx) => saveCredential(ctx, 'hubspot', { kind: 'private_app_token', value: 'pat-xyz-4f2a' }));
    const v = (await t.run((ctx) => listConnections(ctx))).find((c) => c.provider === 'hubspot');
    expect(v!.hint).toBe('4f2a');
  });

  it('keeps the old credential, then the cleanup job deletes it after an hour', async () => {
    const t = await freshTenant();
    await t.run((ctx) => saveCredential(ctx, 'demo', { kind: 'api_key', value: 'first-0001' }));
    await t.run((ctx) => saveCredential(ctx, 'demo', { kind: 'api_key', value: 'second-0002' }));
    let rows = await adminDb.select().from(credential).where(eq(credential.tenantId, t.tenantId));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.replacedAt)).toHaveLength(1);
    const [conn] = await adminDb.select().from(connection).where(eq(connection.tenantId, t.tenantId));
    expect(rows.find((r) => r.id === conn!.credentialId)!.hint).toBe('0002');

    await t.run((ctx) => credentialsCleanupHandler.handle({ data: {} } as never, ctx));
    expect(await adminDb.select().from(credential).where(eq(credential.tenantId, t.tenantId))).toHaveLength(2);

    await adminDb.execute(
      sql`update integrations.credential set replaced_at = now() - interval '2 hours' where tenant_id = ${t.tenantId} and replaced_at is not null`,
    );
    await t.run((ctx) => credentialsCleanupHandler.handle({ data: {} } as never, ctx));
    rows = await adminDb.select().from(credential).where(eq(credential.tenantId, t.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hint).toBe('0002');
  });

  it('refuses with a clear error when there is no master key', async () => {
    const t = await freshTenant();
    const saved = cfg.masterKey;
    // Unset overrides fall through to the real config, which has no key in tests; point the real one away.
    cfg.masterKey = undefined;
    try {
      const { config } = await import('@/platform/config');
      if (config.masterKey) return; // the environment has a real key; nothing to assert
      await expect(
        t.run((ctx) => saveCredential(ctx, 'demo', { kind: 'api_key', value: 'abcd1234' })),
      ).rejects.toMatchObject({ slug: 'master-key-missing', message: MASTER_KEY_MISSING });
    } finally {
      cfg.masterKey = saved;
    }
  });

  it('is isolated per tenant', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    await a.run((ctx) => saveCredential(ctx, 'hubspot', { kind: 'api_key', value: 'only-a-9999' }));
    const v = (await b.run((ctx) => listConnections(ctx))).find((c) => c.provider === 'hubspot');
    expect(v!.hint).toBeUndefined();
    expect(v!.status).toBe('not_set_up');
  });
});

describe('setMode', () => {
  it('refuses live without a credential and a passing test, allows it after, and publishes changed', async () => {
    const t = await freshTenant();
    await expect(t.run((ctx) => setMode(ctx, 'demo', 'live'))).rejects.toThrow(
      'Test the connection before switching it to live.',
    );
    await t.run((ctx) => saveCredential(ctx, 'demo', { kind: 'api_key', value: 'good-token-1' }));
    await expect(t.run((ctx) => setMode(ctx, 'demo', 'live'))).rejects.toThrow('Test the connection before');
    const r = await t.run((ctx) => testConnection(ctx, 'demo'));
    expect(r.ok).toBe(true);
    expect((await events(t.tenantId, 'integrations.connection.tested')).length).toBe(1);
    await t.run((ctx) => setMode(ctx, 'demo', 'live'));
    const [conn] = await adminDb.select().from(connection).where(eq(connection.tenantId, t.tenantId));
    expect(conn!.mode).toBe('live');
    expect((await events(t.tenantId, 'integrations.connection.changed')).length).toBe(1);
  });

  it('refuses live when the passing test is older than 10 minutes', async () => {
    const t = await freshTenant();
    await t.run((ctx) => saveCredential(ctx, 'demo', { kind: 'api_key', value: 'good-token-2' }));
    await t.run((ctx) => testConnection(ctx, 'demo'));
    await adminDb.execute(
      sql`update integrations.connection set last_tested_at = now() - interval '11 minutes' where tenant_id = ${t.tenantId}`,
    );
    await expect(t.run((ctx) => setMode(ctx, 'demo', 'live'))).rejects.toThrow('Test the connection before');
  });

  it('a failed test lists missing permissions, marks the connection failing and does not allow live', async () => {
    const t = await freshTenant();
    await t.run((ctx) => saveCredential(ctx, 'demo', { kind: 'api_key', value: 'bad-token-3' }));
    const r = await t.run((ctx) => testConnection(ctx, 'demo'));
    expect(r).toMatchObject({ ok: false, missingPermissions: ['demo.read'] });
    await expect(t.run((ctx) => setMode(ctx, 'demo', 'live'))).rejects.toThrow('Test the connection before');
    const [conn] = await adminDb.select().from(connection).where(eq(connection.tenantId, t.tenantId));
    expect(conn!.status).toBe('failing');
  });

  it('with SCOUT_FORCE_MOCK it says the environment uses sample data only', async () => {
    const t = await freshTenant();
    cfg.forceMock = true;
    try {
      await expect(t.run((ctx) => setMode(ctx, 'demo', 'live'))).rejects.toThrow(
        'This environment uses sample data only.',
      );
    } finally {
      cfg.forceMock = false;
    }
  });
});

describe('setDisabled', () => {
  it('disables and re-enables, publishing changed', async () => {
    const t = await freshTenant();
    await t.run((ctx) => setDisabled(ctx, 'demo', true));
    let [conn] = await adminDb.select().from(connection).where(eq(connection.tenantId, t.tenantId));
    expect(conn!.status).toBe('disabled');
    await t.run((ctx) => setDisabled(ctx, 'demo', false));
    [conn] = await adminDb.select().from(connection).where(eq(connection.tenantId, t.tenantId));
    expect(conn!.status).toBe('not_set_up');
    expect((await events(t.tenantId, 'integrations.connection.changed')).length).toBe(2);
  });
});
