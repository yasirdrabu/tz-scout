import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { RateLimitedError, gateway, listIntegrations, type CallOpts } from '@/modules/integrations';
import { callLog, usageCap, usagePeriod } from '@/modules/integrations/db/schema';
import { periodBounds, type CapPeriod, type CapUnit } from '@/modules/integrations/domain/caps';
import { tenant } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { freshTenant } from './helpers';

type T = Awaited<ReturnType<typeof freshTenant>>;

/** The demo provider has no default limit, so each test gives it one. */
async function demoWithCap(unit: CapUnit, limit: number, period: CapPeriod = 'month') {
  const t = await freshTenant();
  await adminDb.insert(usageCap).values({ tenantId: t.tenantId, providerKey: 'demo', unit, period, limit });
  return t;
}

const usage = async (t: T) => {
  const [row] = await adminDb
    .select()
    .from(usagePeriod)
    .where(and(eq(usagePeriod.tenantId, t.tenantId), eq(usagePeriod.providerKey, 'demo')));
  return { used: row?.used ?? 0, reserved: row?.reserved ?? 0 };
};
const logs = (t: T) => adminDb.select().from(callLog).where(eq(callLog.tenantId, t.tenantId)).orderBy(callLog.at);
const call = (t: T, opts: CallOpts = {}, fn: () => Promise<unknown> = async () => 'ok') =>
  t.run((ctx) => gateway.call(ctx, 'demo', 'demo.thing.read', fn, opts));

describe('gateway usage limits', () => {
  it('refuses a call over the limit: no adapter call, a blocked_by_cap log row, 429 with resets_at', async () => {
    const t = await demoWithCap('calls', 2);
    await call(t);
    await call(t);
    const fn = vi.fn(async () => 'never');
    const err = await call(t, {}, fn).catch((e: unknown) => e);
    expect(fn).not.toHaveBeenCalled();
    expect(err).toMatchObject({
      slug: 'blocked_by_cap',
      status: 429,
      extensions: { resets_at: periodBounds('month', new Date(), 'UTC').resetsAt.toISOString() },
    });
    const rows = await logs(t);
    expect(rows.map((r) => r.outcome)).toEqual(['ok', 'ok', 'blocked_by_cap']);
    expect(rows[2]).toMatchObject({ durationMs: 0, operation: 'demo.thing.read', units: null, costCents: null });
    expect(await usage(t)).toEqual({ used: 2, reserved: 0 });
  });

  it('a call that throws releases its reservation and adds nothing (Review Focus 3)', async () => {
    const t = await demoWithCap('cost_cents', 100);
    await expect(
      call(t, { reserveCents: 60, costCents: 60 }, async () => {
        throw new Error('upstream broke');
      }),
    ).rejects.toThrow('upstream broke');
    expect(await usage(t)).toEqual({ used: 0, reserved: 0 });
    // The released reservation leaves room for the next one.
    await call(t, { reserveCents: 60, measure: () => ({ costCents: 7 }) });
    expect(await usage(t)).toEqual({ used: 7, reserved: 0 });
  });

  it('reserves cost_cents from reserveCents, so a worst case that would pass the limit is refused', async () => {
    const t = await demoWithCap('cost_cents', 100);
    await call(t, { reserveCents: 50, costCents: 90 });
    expect(await usage(t)).toEqual({ used: 90, reserved: 0 });
    await expect(call(t, { reserveCents: 20 })).rejects.toMatchObject({ slug: 'blocked_by_cap' });
    // A call that spends no cents is not held back by a cents limit.
    await call(t);
    expect((await logs(t)).map((r) => r.outcome)).toEqual(['ok', 'blocked_by_cap', 'ok']);
  });

  it('a credits limit counts only calls whose unit is credits (Ruling 5)', async () => {
    const t = await demoWithCap('credits', 5);
    await call(t, { units: 4, unit: 'records' });
    expect(await usage(t)).toEqual({ used: 0, reserved: 0 });
    await call(t, { units: 3, unit: 'credits', measure: () => ({ units: 2 }) });
    expect(await usage(t)).toEqual({ used: 2, reserved: 0 });
    await expect(call(t, { units: 4, unit: 'credits' })).rejects.toMatchObject({ slug: 'blocked_by_cap' });
    await call(t, { units: 9, unit: 'records' });
    expect((await logs(t)).map((r) => r.outcome)).toEqual(['ok', 'ok', 'blocked_by_cap', 'ok']);
  });

  it('a calls limit counts every call, whatever its unit', async () => {
    const t = await demoWithCap('calls', 10, 'day');
    await call(t, { units: 4, unit: 'records' });
    await call(t, { units: 3, unit: 'credits' });
    await call(t, { costCents: 12 });
    expect(await usage(t)).toEqual({ used: 3, reserved: 0 });
  });

  it('a provider without a limit is never refused', async () => {
    const t = await freshTenant();
    await call(t, { units: 1_000_000, unit: 'credits', reserveCents: 1_000_000 });
    expect((await logs(t)).map((r) => r.outcome)).toEqual(['ok']);
    expect(await usage(t)).toEqual({ used: 0, reserved: 0 });
  });

  it('a calls limit counts failed and rate-limited calls: they reached the service', async () => {
    const t = await demoWithCap('calls', 2);
    await expect(call(t, {}, async () => Promise.reject(new Error('broke')))).rejects.toThrow('broke');
    await expect(call(t, {}, async () => Promise.reject(new RateLimitedError()))).rejects.toBeInstanceOf(RateLimitedError);
    expect(await usage(t)).toEqual({ used: 2, reserved: 0 });
    const fn = vi.fn(async () => 'never');
    await expect(call(t, {}, fn)).rejects.toMatchObject({ slug: 'blocked_by_cap' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('a measured amount that is not a number keeps the call log row and falls back to the given amount', async () => {
    const t = await demoWithCap('cost_cents', 100);
    await call(t, { reserveCents: 10, costCents: 4, measure: () => ({ costCents: Number.NaN, units: Number.POSITIVE_INFINITY }) });
    const rows = await logs(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'ok', costCents: 4, units: null });
    expect(await usage(t)).toEqual({ used: 4, reserved: 0 });
  });

  it('counts usage only known after the call; such a call is not refused up front', async () => {
    const credits = await demoWithCap('credits', 5);
    await call(credits, { unit: 'credits', measure: () => ({ units: 6 }) });
    expect(await usage(credits)).toEqual({ used: 6, reserved: 0 });
    // Now over the limit: a call with no estimate still runs and counts; one with an estimate is refused.
    await call(credits, { unit: 'credits', measure: () => ({ units: 1 }) });
    expect(await usage(credits)).toEqual({ used: 7, reserved: 0 });
    await expect(call(credits, { unit: 'credits', units: 1 })).rejects.toMatchObject({ slug: 'blocked_by_cap' });

    const cents = await demoWithCap('cost_cents', 100);
    await call(cents, { measure: () => ({ costCents: 30 }) });
    await call(cents, { costCents: 5 });
    expect(await usage(cents)).toEqual({ used: 35, reserved: 0 });
  });
});

describe('Integrations overview with limits', () => {
  it('calls_today_cap comes from a daily calls limit; each row carries its limit', async () => {
    const t = await freshTenant();
    const rows = await t.run((ctx) => listIntegrations(ctx));
    const hubspot = rows.find((r) => r.key === 'hubspot')!;
    const apollo = rows.find((r) => r.key === 'apollo')!;
    expect(hubspot.callsTodayCap).toBe(50000);
    expect(hubspot.cap).toMatchObject({ providerKey: 'hubspot', unit: 'calls', period: 'day', limit: 50000, used: 0 });
    expect(apollo.callsTodayCap).toBeNull();
    expect(apollo.cap).toMatchObject({ unit: 'credits', period: 'month', limit: 2000 });
    expect(rows.find((r) => r.key === 'vibe')!.cap?.limit).toBe(1000);
    expect(rows.find((r) => r.key === 'email')!.cap).toBeNull();
  });

  it('counts Calls today from the tenant’s local midnight, not UTC midnight', async () => {
    const t = await freshTenant();
    // UTC-11 all year: local midnight is 11:00 UTC, so one of the two rows below sits on the other side of UTC midnight.
    await adminDb.update(tenant).set({ timezone: 'Pacific/Pago_Pago' }).where(eq(tenant.id, t.tenantId));
    const { start } = periodBounds('day', new Date(), 'Pacific/Pago_Pago');
    const midnight = Date.parse(`${start}T00:00:00-11:00`);
    for (const at of [midnight - 60_000, midnight + 1]) {
      await adminDb.insert(callLog).values({
        id: newId('call'),
        tenantId: t.tenantId,
        provider: 'apollo',
        operation: 'apollo.test',
        outcome: 'ok',
        durationMs: 10,
        at: new Date(at),
      });
    }
    const apollo = (await t.run((ctx) => listIntegrations(ctx))).find((r) => r.key === 'apollo')!;
    expect(apollo.callsToday).toBe(1);
  });
});
