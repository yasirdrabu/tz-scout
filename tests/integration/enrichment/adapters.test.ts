// The enrichment adapters through the gateway: Apollo's sample data and its credits limit, the company website going
// live with no key, Vibe staying sample data, and `markConnectionFailing`.
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/config', async (orig) => {
  const real = await orig<typeof import('@/platform/config')>();
  const { cfg } = await import('../integrations/cfg');
  const over = cfg as Record<string, unknown>;
  return {
    ...real,
    config: new Proxy(real.config, {
      get: (t, p) => (over[p as string] !== undefined ? over[p as string] : (t as never)[p]),
    }),
  };
});

import '@/entry/compose';
import { setMockFailure, type EnrichmentAdapter } from '@/modules/enrichment';
import { NOT_LIVE_YET, gateway, listCaps, markConnectionFailing, setDisabled, setMode, testConnection } from '@/modules/integrations';
import { callLog, connection } from '@/modules/integrations/db/schema';
import { adminDb } from '@/platform/db/client';
import { freshTenant } from '../integrations/helpers';

const connOf = async (tenantId: string, provider: string) =>
  (await adminDb.select().from(connection).where(eq(connection.tenantId, tenantId))).find((c) => c.provider === provider);
const credits = { module: 'enrichment', unit: 'credits' } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  setMockFailure(null);
});

describe('Apollo through the gateway', () => {
  it('in mock mode returns the sample company and settles 1 credit against the apollo limit', async () => {
    const t = await freshTenant();
    const r = await t.run((ctx) =>
      gateway.call(ctx, 'apollo', 'organizations/enrich', (a) => (a as EnrichmentAdapter).companyEnrich({ domain: 'northgate-freight.com' }), {
        ...credits,
        units: 1,
        measure: (x: { creditsUsed: number }) => ({ units: x.creditsUsed }),
        requestSummary: { requestId: 'enr_x' },
      }),
    );
    expect(r.creditsUsed).toBe(1);
    expect(r.value).toMatchObject({ name: 'Northgate Freight', domain: 'northgate-freight.com', industry: 'Logistics', country: 'United States' });
    // Deterministic per domain.
    const again = await t.run((ctx) => gateway.call(ctx, 'apollo', 'organizations/enrich', (a) => (a as EnrichmentAdapter).companyEnrich({ domain: 'northgate-freight.com' })));
    expect(again.value).toEqual(r.value);
    const cap = (await t.run((ctx) => listCaps(ctx))).find((c) => c.providerKey === 'apollo')!;
    expect(cap).toMatchObject({ unit: 'credits', used: 1, reserved: 0 });
    const [log] = await adminDb.select().from(callLog).where(eq(callLog.tenantId, t.tenantId));
    expect(log).toMatchObject({ provider: 'apollo', operation: 'organizations/enrich', outcome: 'ok', units: 1, unit: 'credits', module: 'enrichment' });
  });

  it('a sample failure fails the call as the live adapter would, and spends no credits', async () => {
    const t = await freshTenant();
    setMockFailure('out_of_credits', 1);
    const call = () =>
      t.run((ctx) =>
        gateway.call(ctx, 'apollo', 'people/match', (a) => (a as EnrichmentAdapter).revealEmail({ person: { name: 'Pat Lee' }, domain: 'acme.com' }), {
          ...credits,
          units: 1,
          measure: (x: { creditsUsed: number }) => ({ units: x.creditsUsed }),
        }),
      );
    expect((await call()).value).toMatchObject({ email: 'pat.lee@acme.com', email_status: 'verified' });
    await expect(call()).rejects.toMatchObject({ kind: 'out_of_credits', message: 'Apollo is out of credits.' });
    expect((await t.run((ctx) => listCaps(ctx))).find((c) => c.providerKey === 'apollo')).toMatchObject({ used: 1, reserved: 0 });
  });
});

describe('the company website', () => {
  it('goes live with no credential, and reads with a stubbed fetch', async () => {
    const t = await freshTenant();
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: string) => {
      seen.push(input);
      const path = new URL(input).pathname;
      if (path !== '/') return new Response('', { status: 404 });
      return new Response('<title>Acme</title><meta name="description" content="Acme moves freight.">', { headers: { 'content-type': 'text/html' } });
    });
    const tested = await t.run((ctx) => testConnection(ctx, 'website'));
    expect(tested.ok).toBe(true);
    await t.run((ctx) => setMode(ctx, 'website', 'live'));
    const read = await t.run((ctx) => gateway.call(ctx, 'website', 'website.read', (a) => (a as EnrichmentAdapter).readSite({ domain: 'acme.com' }), { module: 'enrichment' }));
    expect(read.pages).toHaveLength(1);
    expect(read.pages[0]).toMatchObject({ url: 'https://acme.com/', title: 'Acme' });
    expect(seen).toEqual(['https://acme.com/robots.txt', 'https://acme.com/']);
    expect(await connOf(t.tenantId, 'website')).toMatchObject({ mode: 'live', status: 'connected', credentialId: null });
  });

  it('defaults to the two sample pages', async () => {
    const t = await freshTenant();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const read = await t.run((ctx) => gateway.call(ctx, 'website', 'website.read', (a) => (a as EnrichmentAdapter).readSite({ domain: 'acme.com' })));
    expect(read.pages.map((p) => p.url)).toEqual(['https://acme.com/', 'https://acme.com/about']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stays on sample pages for a test key even when live', async () => {
    const t = await freshTenant();
    await t.run((ctx) => testConnection(ctx, 'website'));
    await t.run((ctx) => setMode(ctx, 'website', 'live'));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const read = await t.run((ctx) =>
      gateway.call({ ...ctx, environment: 'test' }, 'website', 'website.read', (a) => (a as EnrichmentAdapter).readSite({ domain: 'acme.com' })),
    );
    expect(read.pages).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Vibe', () => {
  it('answers with sample data and cannot be set live', async () => {
    const t = await freshTenant();
    const r = await t.run((ctx) => gateway.call(ctx, 'vibe', 'organizations/enrich', (a) => (a as EnrichmentAdapter).companyEnrich({ domain: 'fortegra.com' })));
    expect(r).toMatchObject({ creditsUsed: 1, value: { name: 'Fortegra', domain: 'fortegra.com', provider_ref: 'vibe-b:fortegra.com' } });
    await expect(t.run((ctx) => setMode(ctx, 'vibe', 'live'))).rejects.toMatchObject({ slug: 'live-unavailable', message: NOT_LIVE_YET });
  });
});

describe('markConnectionFailing', () => {
  it('sets status failing and the last error, creating the connection when there is none', async () => {
    const t = await freshTenant();
    await t.run((ctx) => markConnectionFailing(ctx, 'apollo', 'Apollo rejected the key. An owner needs to update it in Integrations.'));
    expect(await connOf(t.tenantId, 'apollo')).toMatchObject({
      status: 'failing',
      lastError: 'Apollo rejected the key. An owner needs to update it in Integrations.',
    });
  });

  it('scrubs the message and leaves a turned-off connection off', async () => {
    const t = await freshTenant();
    await t.run((ctx) => setDisabled(ctx, 'vibe', true));
    await t.run((ctx) => markConnectionFailing(ctx, 'vibe', 'Refused Bearer abcdefghijklmnop'));
    expect(await connOf(t.tenantId, 'vibe')).toMatchObject({ status: 'disabled', lastError: 'Refused Bearer [redacted]' });
  });
});
