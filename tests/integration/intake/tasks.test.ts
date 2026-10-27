import { beforeAll, describe, expect, it, vi } from 'vitest';

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

import type { AnthropicAdapter } from '@/modules/ai-tasks';
import { anthropicMock, registerAnthropicAdapter } from '@/modules/ai-tasks/adapters/anthropic/mock';
import { registerAdapter, saveCredential, setMode, testConnection } from '@/modules/integrations';
import { normaliseWithAi } from '@/modules/intake/tasks/arrival-normalise';
import { suggestMapping } from '@/modules/intake/tasks/csv-column-mapping';
import { cfg } from '../integrations/cfg';
import { newKey } from '../integrations/helpers';
import { freshTenant, type Tenant } from './helpers';

beforeAll(() => {
  cfg.masterKey = newKey();
});

/** Registers a fake live Claude adapter, then switches the tenant to live. */
async function goLive(t: Tenant, complete: (req: unknown) => Promise<unknown>) {
  const adapter: AnthropicAdapter = {
    async test() {
      return { ok: true, message: 'Claude answered.' };
    },
    complete: complete as unknown as AnthropicAdapter['complete'],
  };
  registerAdapter('anthropic', { mock: () => anthropicMock, live: () => adapter });
  await t.run((ctx) => saveCredential(ctx, 'anthropic', { kind: 'api_key', value: 'sk-ant-test-key-123456' }));
  await t.run((ctx) => testConnection(ctx, 'anthropic'));
  await t.run((ctx) => setMode(ctx, 'anthropic', 'live'));
}
const reply = (json: unknown) => async () => ({ json, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 });

const headers = ['Website', 'Company', 'Odd Column'];
const sampleRows = [['acme.com', 'Acme', 'x']];

describe('intake AI tasks', () => {
  it('falls back to nulls and synonyms with no Claude connection', async () => {
    registerAnthropicAdapter();
    const t = await freshTenant();
    expect(await t.run((ctx) => normaliseWithAi(ctx, { industry: 'Widgets', relationship: 'my cousin' }))).toEqual({
      industryKey: null,
      relationshipKey: null,
    });
    const r = await t.run((ctx) => suggestMapping(ctx, headers, sampleRows));
    expect(r.origin).toBe('synonyms');
    expect(r.mapping.find((c) => c.header === 'Website')?.target).toBe('account.website');
  });

  it('returns nulls when the live call throws', async () => {
    const t = await freshTenant();
    await goLive(t, async () => {
      throw new Error('boom');
    });
    expect(await t.run((ctx) => normaliseWithAi(ctx, { industry: 'Widgets' }))).toEqual({ industryKey: null, relationshipKey: null });
    const r = await t.run((ctx) => suggestMapping(ctx, headers, sampleRows));
    expect(r.origin).toBe('synonyms');
  });

  it('uses a live answer, nulls disallowed targets and drops low confidence columns', async () => {
    const t = await freshTenant();
    await goLive(t,
      reply({
        columns: [
          { header: 'Website', target: 'account.website', confidence: 0.95, reason: 'URLs' },
          { header: 'Company', target: 'account.password', confidence: 0.9, reason: 'bad' },
          { header: 'Odd Column', target: 'account.notes', confidence: 0.3, reason: 'unsure' },
        ],
      }),
    );
    const r = await t.run((ctx) => suggestMapping(ctx, headers, sampleRows));
    expect(r.origin).toBe('ai');
    expect(r.mapping.map((c) => c.target)).toEqual(['account.website', null, null]);
  });

  it('returns a live industry and relationship answer', async () => {
    const t = await freshTenant();
    await goLive(t, reply({ industryKey: 'software', relationshipKey: 'partner_referral' }));
    expect(await t.run((ctx) => normaliseWithAi(ctx, { industry: 'Widgets', relationship: 'x' }))).toEqual({
      industryKey: 'software',
      relationshipKey: 'partner_referral',
    });
  });
});
