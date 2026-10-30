import { and, eq } from 'drizzle-orm';
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

import { listConnections, registerAdapter, saveCredential, setConnectionSettings, testConnection, type Adapter } from '@/modules/integrations';
import { connection, credential } from '@/modules/integrations/db/schema';
import { adminDb } from '@/platform/db/client';
import { auditLog as auditTable } from '@/platform/db/schema';
import { cfg } from './cfg';
import { freshTenant, newKey } from './helpers';

// A stand-in live adapter, so the service is tested without the network.
let outcome: { ok: boolean; facts?: Record<string, string> } = { ok: true, facts: { portal_id: '4242', portal_name: 'Acme Portal' } };
beforeAll(() => {
  cfg.masterKey = newKey();
  cfg.forceMock = false;
  registerAdapter('hubspot', {
    mock: (): Adapter => ({ test: async () => ({ ok: true, message: 'Sample data.' }) }),
    live: (): Adapter => ({ test: async () => ({ message: 'Connected.', ...outcome }) }),
  });
});

const conn = async (tenantId: string) => (await adminDb.select().from(connection).where(eq(connection.tenantId, tenantId)))[0]!;
const creds = (tenantId: string) => adminDb.select().from(credential).where(eq(credential.tenantId, tenantId));

describe('HubSpot client secret beside the token (Ruling 16)', () => {
  it('stores a client_secret without making it the connection credential', async () => {
    const t = await freshTenant();
    await t.run((ctx) => saveCredential(ctx, 'hubspot', { kind: 'private_app_token', value: 'pat-na1-token-aaaa1111' }));
    const tokenId = (await conn(t.tenantId)).credentialId;
    await t.run((ctx) => saveCredential(ctx, 'hubspot', { kind: 'client_secret', value: 'client-secret-bbbb2222' }));
    const after = await conn(t.tenantId);
    expect(after.credentialId).toBe(tokenId);
    const rows = await creds(t.tenantId);
    expect(rows.map((r) => r.kind).sort()).toEqual(['client_secret', 'private_app_token']);
    expect(rows.find((r) => r.id === tokenId)!.replacedAt).toBeNull();
  });

  it('a new secret replaces only the earlier secret, and a token replaces only the token', async () => {
    const t = await freshTenant();
    await t.run((ctx) => saveCredential(ctx, 'hubspot', { kind: 'private_app_token', value: 'pat-na1-token-aaaa1111' }));
    await t.run((ctx) => saveCredential(ctx, 'hubspot', { kind: 'client_secret', value: 'client-secret-one-1111' }));
    await t.run((ctx) => saveCredential(ctx, 'hubspot', { kind: 'client_secret', value: 'client-secret-two-2222' }));
    let rows = await creds(t.tenantId);
    const live = (kind: string) => rows.filter((r) => r.kind === kind && r.replacedAt === null);
    expect(live('client_secret')).toHaveLength(1);
    expect(live('private_app_token')).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'client_secret' && r.replacedAt !== null)).toHaveLength(1);

    const before = (await conn(t.tenantId)).credentialId;
    await t.run((ctx) => saveCredential(ctx, 'hubspot', { kind: 'private_app_token', value: 'pat-na1-token-cccc3333' }));
    rows = await creds(t.tenantId);
    expect((await conn(t.tenantId)).credentialId).not.toBe(before);
    expect(live('client_secret')).toHaveLength(1);
    expect(rows.find((r) => r.id === before)!.replacedAt).not.toBeNull();
  });

  it('a secret saved alone leaves the connection not set up and does not clear a passing test', async () => {
    const t = await freshTenant();
    await t.run((ctx) => saveCredential(ctx, 'hubspot', { kind: 'client_secret', value: 'client-secret-only-1111' }));
    const c = await conn(t.tenantId);
    expect(c.credentialId).toBeNull();
    const result = await t.run((ctx) => testConnection(ctx, 'hubspot'));
    expect(result.ok).toBe(true);
    expect((await conn(t.tenantId)).status).toBe('not_set_up');
    const view = (await t.run((ctx) => listConnections(ctx))).find((v) => v.provider === 'hubspot')!;
    expect(view.hint).toBeUndefined();

    await t.run((ctx) => saveCredential(ctx, 'hubspot', { kind: 'private_app_token', value: 'pat-na1-token-aaaa1111' }));
    await t.run((ctx) => testConnection(ctx, 'hubspot'));
    await t.run((ctx) => saveCredential(ctx, 'hubspot', { kind: 'client_secret', value: 'client-secret-new-2222' }));
    expect((await conn(t.tenantId)).lastTestResult).toMatchObject({ ok: true });
  });
});

describe('connection test facts', () => {
  it('merges the facts of a passing test into connection.settings and keeps other settings', async () => {
    const t = await freshTenant();
    await t.run((ctx) => saveCredential(ctx, 'hubspot', { kind: 'private_app_token', value: 'pat-na1-token-aaaa1111' }));
    await t.run((ctx) => setConnectionSettings(ctx, 'hubspot', { qualified_lead_rule: { property: 'lifecyclestage', value: 'lead' } }));
    outcome = { ok: true, facts: { portal_id: '4242', portal_name: 'Acme Portal' } };
    const r = await t.run((ctx) => testConnection(ctx, 'hubspot'));
    expect(r.facts).toEqual({ portal_id: '4242', portal_name: 'Acme Portal' });
    expect((await conn(t.tenantId)).settings).toEqual({
      qualified_lead_rule: { property: 'lifecyclestage', value: 'lead' },
      portal_id: '4242',
      portal_name: 'Acme Portal',
    });
  });

  it('does not touch settings when the test fails', async () => {
    const t = await freshTenant();
    await t.run((ctx) => saveCredential(ctx, 'hubspot', { kind: 'private_app_token', value: 'pat-na1-token-aaaa1111' }));
    outcome = { ok: false, facts: { portal_id: '999' } };
    await t.run((ctx) => testConnection(ctx, 'hubspot'));
    expect((await conn(t.tenantId)).settings).toEqual({});
    outcome = { ok: true, facts: { portal_id: '4242', portal_name: 'Acme Portal' } };
  });
});

describe('setConnectionSettings', () => {
  it('merges shallowly and writes an audit row', async () => {
    const t = await freshTenant();
    await t.run((ctx) => setConnectionSettings(ctx, 'hubspot', { a: 1, b: { x: 1 } }));
    const merged = await t.run((ctx) => setConnectionSettings(ctx, 'hubspot', { b: { y: 2 }, c: 'z' }));
    expect(merged).toEqual({ a: 1, b: { y: 2 }, c: 'z' });
    expect((await conn(t.tenantId)).settings).toEqual({ a: 1, b: { y: 2 }, c: 'z' });
    const rows = await adminDb
      .select()
      .from(auditTable)
      .where(and(eq(auditTable.tenantId, t.tenantId), eq(auditTable.action, 'integrations.connection.settings_changed')));
    expect(rows).toHaveLength(2);
  });

  it('refuses an unknown provider', async () => {
    const t = await freshTenant();
    await expect(t.run((ctx) => setConnectionSettings(ctx, 'nope', { a: 1 }))).rejects.toThrow('Unknown integration');
  });
});

