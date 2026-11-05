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
  let n = 0;
  /** Publishes a level event (the next seq unless given) and delivers it. */
  const pause = async (category: CostCategory, month: string, level: 'paused' | 'ok' = 'paused', seq = ++n) => {
    await publishTestEvent(t.tenantId, budgetLevelChanged, { category, month, level, spentCents: 11_000, budgetCents: 10_000, seq });
    await runOutbox(t.tenantId);
  };
  const logs = () => adminDb.select().from(callLog).where(eq(callLog.tenantId, t.tenantId)).orderBy(callLog.at);
  /** The current month and day in the tenant's timezone, as the gateway and analytics read them. */
  const month = () => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).format(new Date());
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  return { tenantId: t.tenantId, run, call, pause, logs, month, today };
}

describe('the paid_pause flag', () => {
  it('follows analytics levels: paused sets it, a lower level clears it, for the tenant month', async () => {
    // 12:00 UTC on 30 November is 02:00 on 1 December in Kiritimati (UTC+14): a UTC month would be wrong.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-30T12:00:00Z'));
    const w = await workspace('Pacific/Kiritimati');
    expect(w.month()).toBe('2026-12');
    await w.run((ctx) => saveBudgets(ctx, w.month(), [{ category: 'ai_usage', amountCents: 10_000 }]));
    await w.run((ctx) => addManualLine(ctx, { occurredOn: w.today(), category: 'ai_usage', amountCents: 11_000, note: null }));
    await runOutbox(w.tenantId);
    const rows = () => adminDb.select().from(paidPause).where(eq(paidPause.tenantId, w.tenantId));
    expect(await rows()).toEqual([{ tenantId: w.tenantId, category: 'ai_usage', month: '2026-12', paused: true, seq: 1 }]);
    expect(await w.run((ctx) => isPaused(ctx, 'anthropic', new Date()))).toBe(true);

    // Raising the budget drops the level, and the flag clears at once.
    await w.run((ctx) => saveBudgets(ctx, w.month(), [{ category: 'ai_usage', amountCents: 50_000 }]));
    await runOutbox(w.tenantId);
    expect((await rows()).map((r) => [r.paused, r.seq])).toEqual([[false, 2]]);
    expect(await w.run((ctx) => isPaused(ctx, 'anthropic', new Date()))).toBe(false);
  });

  it('a late older event is ignored: ok (seq 2) then paused (seq 1) stays unpaused', async () => {
    const w = await workspace('America/New_York');
    await w.pause('data_vendors', w.month(), 'ok', 2);
    await w.pause('data_vendors', w.month(), 'paused', 1);
    expect(await w.run((ctx) => isPaused(ctx, 'apollo', new Date()))).toBe(false);
    // A late ok after a newer pause is ignored too.
    await w.pause('data_vendors', w.month(), 'paused', 4);
    await w.pause('data_vendors', w.month(), 'ok', 3);
    expect(await w.run((ctx) => isPaused(ctx, 'apollo', new Date()))).toBe(true);
  });

  it('in order, each event applies: paused (seq 1) then ok (seq 2)', async () => {
    const w = await workspace('America/New_York');
    await w.pause('data_vendors', w.month(), 'paused', 1);
    expect(await w.run((ctx) => isPaused(ctx, 'apollo', new Date()))).toBe(true);
    await w.pause('data_vendors', w.month(), 'ok', 2);
    expect(await w.run((ctx) => isPaused(ctx, 'apollo', new Date()))).toBe(false);
  });
});

describe('the gateway refuses paused paid calls (Ruling 9)', () => {
  it('a live Claude call is refused before any outside call, logged blocked_by_cap with the detail; HubSpot and Apollo still go through', async () => {
    const w = await workspace();
    await w.run((ctx) => saveCredential(ctx, 'anthropic', { kind: 'api_key', value: 'sk-ant-test-key-123456' }));
    await w.run((ctx) => testConnection(ctx, 'anthropic'));
    await w.run((ctx) => setMode(ctx, 'anthropic', 'live'));
    await w.pause('ai_usage', w.month());

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
    await w.pause('data_vendors', w.month());
    const fn = vi.fn(async () => 'never');
    await expect(w.call('apollo', fn)).rejects.toMatchObject({
      slug: 'blocked_by_cap',
      detail: 'Data vendors is over its monthly budget. An owner or leader can raise it on the Costs page.',
    });
    expect(fn).not.toHaveBeenCalled();
    // Back to ok: the next call goes through.
    await w.pause('data_vendors', w.month(), 'ok');
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
    await w.pause('data_vendors', w.month());
    expect(await w.run((ctx) => checkCap(ctx, 'apollo', 1))).toMatchObject({ status: 'blocked', paused: 'data_vendors', limit: 2000 });
    expect(await w.run((ctx) => checkCap(ctx, 'anthropic', 1))).toMatchObject({ status: 'ok' });
    expect(await w.run((ctx) => checkCap(ctx, 'anthropic', 1))).not.toHaveProperty('paused');
    expect((await w.run((ctx) => checkCap(ctx, 'hubspot', 1))).status).toBe('ok');
    const [row] = await adminDb.select().from(paidPause).where(and(eq(paidPause.tenantId, w.tenantId), eq(paidPause.category, 'data_vendors')));
    expect(row!.paused).toBe(true);
  });
});
