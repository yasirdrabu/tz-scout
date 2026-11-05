// R3a Ruling 9: paid calls in a category over 110% of its monthly budget wait, live or sample.
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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

import { addManualLine, budgetLevelChanged, saveBudgets } from '@/modules/analytics';
import { checkCap, gateway, isCapWait, isPaused, registerAdapter, saveCredential, setMode, testConnection, type Adapter } from '@/modules/integrations';
import type { CostCategory } from '@/modules/integrations/contracts/costs';
import { callLog, paidPause } from '@/modules/integrations/db/schema';
import { createTenant } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { adminDb } from '@/platform/db/client';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';
import { cfg } from './cfg';
import { newKey } from './helpers';

const AI_DETAIL = 'AI usage is over its monthly budget. An owner or leader can raise it on the Costs page.';

const fake: Adapter = { test: async () => ({ ok: true, message: 'Answered.' }) };

beforeAll(() => {
  cfg.masterKey = newKey();
  registerAdapter('anthropic', { mock: () => fake, live: () => fake });
  registerAdapter('hubspot', { mock: () => fake });
  registerAdapter('apollo', { mock: () => fake });
});
afterEach(() => vi.useRealTimers());

async function workspace(timezone = 'UTC') {
  const admin = await seedUser({ admin: true });
  const owner = await seedUser({ signedIn: true });
  const t = await createTenant(admin.actor, { slug: uniqueSlug(), name: 'Pause', currency: 'USD', timezone, ownerEmail: owner.email });
  const run = <T>(fn: (ctx: ModuleContext) => Promise<T>) => inTenant(t.tenantId, owner.actor, fn);
  const call = (provider: string, fn = vi.fn(async () => 'ok')) => run((ctx) => gateway.call(ctx, provider, `${provider}.thing`, fn, { reserveCents: 5 }));
  const pause = async (category: CostCategory, month: string, level: 'paused' | 'ok' = 'paused') => {
    await publishTestEvent(t.tenantId, budgetLevelChanged, { category, month, level, spentCents: 11_000, budgetCents: 10_000 });
    await runOutbox(t.tenantId);
  };
  const logs = () => adminDb.select().from(callLog).where(eq(callLog.tenantId, t.tenantId)).orderBy(callLog.at);
  return { tenantId: t.tenantId, run, call, pause, logs };
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

describe('the paid_pause flag', () => {
  it('follows analytics levels: paused sets it, a lower level clears it, for that month only', async () => {
    const w = await workspace();
    await w.run((ctx) => saveBudgets(ctx, thisMonth(), [{ category: 'ai_usage', amountCents: 10_000 }]));
    await w.run((ctx) => addManualLine(ctx, { occurredOn: new Date().toISOString().slice(0, 10), category: 'ai_usage', amountCents: 11_000, note: null }));
    await runOutbox(w.tenantId);
    const rows = () => adminDb.select().from(paidPause).where(eq(paidPause.tenantId, w.tenantId));
    expect(await rows()).toEqual([{ tenantId: w.tenantId, category: 'ai_usage', month: thisMonth(), paused: true }]);
    expect(await w.run((ctx) => isPaused(ctx, 'anthropic', new Date()))).toBe(true);

    // Raising the budget drops the level, and the flag clears at once.
    await w.run((ctx) => saveBudgets(ctx, thisMonth(), [{ category: 'ai_usage', amountCents: 50_000 }]));
    await runOutbox(w.tenantId);
    expect((await rows()).map((r) => r.paused)).toEqual([false]);
    expect(await w.run((ctx) => isPaused(ctx, 'anthropic', new Date()))).toBe(false);
  });
});

describe('the gateway refuses paused paid calls (Ruling 9)', () => {
  it('a live Claude call is refused before any outside call, logged blocked_by_cap with the detail; HubSpot and Apollo still go through', async () => {
    const w = await workspace();
    await w.run((ctx) => saveCredential(ctx, 'anthropic', { kind: 'api_key', value: 'sk-ant-test-key-123456' }));
    await w.run((ctx) => testConnection(ctx, 'anthropic'));
    await w.run((ctx) => setMode(ctx, 'anthropic', 'live'));
    await w.pause('ai_usage', thisMonth());

    const fn = vi.fn(async () => 'never');
    const err = await w.call('anthropic', fn).catch((e: unknown) => e);
    expect(fn).not.toHaveBeenCalled();
    expect(isCapWait(err)).toBe(true);
    expect(err).toMatchObject({ slug: 'blocked_by_cap', status: 429, message: 'AI usage is over its monthly budget.', detail: AI_DETAIL });
    const hubspot = vi.fn(async () => 'ok');
    const apollo = vi.fn(async () => 'ok');
    await w.call('hubspot', hubspot);
    await w.call('apollo', apollo);
    expect(hubspot).toHaveBeenCalledOnce();
    expect(apollo).toHaveBeenCalledOnce();
    const rows = (await w.logs()).filter((r) => r.operation !== 'anthropic.test');
    expect(rows.map((r) => [r.provider, r.outcome])).toEqual([
      ['anthropic', 'blocked_by_cap'],
      ['hubspot', 'ok'],
      ['apollo', 'ok'],
    ]);
    expect(rows[0]).toMatchObject({ errorMessage: AI_DETAIL, durationMs: 0 });
  });

  it('a sample call to a paused provider is refused too', async () => {
    const w = await workspace();
    await w.pause('data_vendors', thisMonth());
    const fn = vi.fn(async () => 'never');
    await expect(w.call('apollo', fn)).rejects.toMatchObject({
      slug: 'blocked_by_cap',
      detail: 'Data vendors is over its monthly budget. An owner or leader can raise it on the Costs page.',
    });
    expect(fn).not.toHaveBeenCalled();
    // Back to ok: the next call goes through.
    await w.pause('data_vendors', thisMonth(), 'ok');
    await w.call('apollo', fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('a pause for October does not block a call on November 1 in the tenant timezone (Review Focus 3)', async () => {
    const w = await workspace('America/New_York');
    await w.pause('ai_usage', '2026-10');
    vi.useFakeTimers({ toFake: ['Date'] });
    // 23:30 on 31 October in New York: still October, so paused.
    vi.setSystemTime(new Date('2026-11-01T03:30:00Z'));
    await expect(w.call('anthropic')).rejects.toMatchObject({ slug: 'blocked_by_cap' });
    // 00:30 on 1 November in New York.
    vi.setSystemTime(new Date('2026-11-01T04:30:00Z'));
    const fn = vi.fn(async () => 'ok');
    await w.call('anthropic', fn);
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('checkCap while paused (Ruling 9 pre-check)', () => {
  it('reports blocked and the paused category; an unpaid provider is unaffected', async () => {
    const w = await workspace();
    await w.pause('data_vendors', thisMonth());
    expect(await w.run((ctx) => checkCap(ctx, 'apollo', 1))).toMatchObject({ status: 'blocked', paused: 'data_vendors', limit: 2000 });
    expect(await w.run((ctx) => checkCap(ctx, 'anthropic', 1))).toMatchObject({ status: 'ok' });
    expect(await w.run((ctx) => checkCap(ctx, 'anthropic', 1))).not.toHaveProperty('paused');
    expect((await w.run((ctx) => checkCap(ctx, 'hubspot', 1))).status).toBe('ok');
    const [row] = await adminDb.select().from(paidPause).where(and(eq(paidPause.tenantId, w.tenantId), eq(paidPause.category, 'data_vendors')));
    expect(row!.paused).toBe(true);
  });
});
