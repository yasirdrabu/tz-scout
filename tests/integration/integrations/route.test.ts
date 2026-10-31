import { eq } from 'drizzle-orm';
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

import { v1Route } from '@/http/routes/v1/_lib/v1-route';
import {
  gateway,
  saveCredential,
  setMode,
  testConnection,
  type Adapter,
} from '@/modules/integrations';
import { SYSTEM_GRANTOR, createApiKey, setPrincipalCacheTtl } from '@/modules/tenancy';
import { membership } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { cfg } from './cfg';
import { freshTenant, newKey } from './helpers';

beforeAll(() => {
  cfg.masterKey = newKey();
});
beforeEach(() => setPrincipalCacheTtl(0));

const who = v1Route({}, (_req, _p, ctx) =>
  gateway.call(ctx, 'demo', 'demo.who', async (a: Adapter) => ({ message: (await a.test()).message })),
);

describe('v1 route with the gateway', () => {
  it('gives a test API key the mock adapter even when the connection is live, and a live key the live one', async () => {
    const t = await freshTenant();
    await adminDb.update(membership).set({ status: 'active' }).where(eq(membership.tenantId, t.tenantId));
    await t.run((ctx) => saveCredential(ctx, 'demo', { kind: 'api_key', value: 'good-token-route' }));
    await t.run((ctx) => testConnection(ctx, 'demo'));
    await t.run((ctx) => setMode(ctx, 'demo', 'live'));
    const key = (environment: 'live' | 'test') =>
      t.run((ctx) => createApiKey(ctx, { name: 'k', environment, scopes: ['members:read'] as never }, SYSTEM_GRANTOR));
    const call = async (secret: string) =>
      (await who(new Request('http://x/v1/x', { headers: { authorization: `Bearer ${secret}` } }))).json();

    expect(await call((await key('test')).secret)).toEqual({ message: 'Sample data is working.' });
    expect(await call((await key('live')).secret)).toEqual({ message: 'Connected to the demo service.' });
  });
});
